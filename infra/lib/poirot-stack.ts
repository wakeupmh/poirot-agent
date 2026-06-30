import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_codebuild as codebuild,
  aws_iam as iam,
  aws_lambda_nodejs as lambdaNode,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secrets,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface PoirotStackProps extends cdk.StackProps {
  /** GitHub owner that hosts this repo (CodeBuild clones it to run buildspec.yml). */
  repoOwner: string;
  /** GitHub repo name. */
  repoName: string;
  /** Optional Claude model override for Claude Code (omit to use the account default). */
  claudeModel?: string;
  /** Optional: existing log group to attach an example error-spike alarm to. */
  targetLogGroupName?: string;
}

const REPO_ROOT = path.join(__dirname, "..", "..");

export class PoirotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PoirotStackProps) {
    super(scope, id, props);

    // --- Secret: the Claude subscription token (populate after deploy) ------
    // Generate it with `claude setup-token` (Pro/Max account); usage is then
    // billed against the subscription rather than per API token.
    const claudeToken = new secrets.Secret(this, "ClaudeToken", {
      secretName: "poirot-agent/claude-token",
      description: "Claude Code OAuth token from `claude setup-token`. Populate after deploy.",
    });

    // --- SNS: reports out, alarms in ---------------------------------------
    const reportsTopic = new sns.Topic(this, "ReportsTopic", {
      displayName: "Poirot incident reports",
    });
    // CloudWatch alarms publish here; the trigger Lambda is subscribed.
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "Poirot incoming alarms",
    });

    // --- Dual-role pattern --------------------------------------------------
    // 1) Build role: minimal — assume the investigator role, publish reports,
    //    read the secret, and write its own logs. Created explicitly so the
    //    investigator role can trust it up front (no dependency cycle).
    const buildRole = new iam.Role(this, "BuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "Poirot CodeBuild role: assume read-only role + publish reports.",
    });

    // 2) Investigator role: what Claude Code actually uses. Broad read access
    //    (ReadOnlyAccess) so it can investigate anything, but with an explicit
    //    DENY on the high-value data reads. Poirot ingests untrusted log content
    //    — a prompt-injection surface — and then publishes a report, so we make
    //    sure it physically cannot read secrets/keys/object data and exfiltrate
    //    them. An explicit Deny always wins over the managed Allow.
    const investigatorRole = new iam.Role(this, "InvestigatorRole", {
      assumedBy: new iam.ArnPrincipal(buildRole.roleArn),
      description: "Read-only role Claude Code assumes to investigate. Cannot mutate anything.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"),
      ],
      maxSessionDuration: cdk.Duration.hours(1),
    });
    investigatorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenySensitiveDataReads",
        effect: iam.Effect.DENY,
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:BatchGetSecretValue",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "kms:Decrypt",
          "s3:GetObject",
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          // These can expose secrets stored in env vars / inline templates
          "lambda:GetFunction",
          "ecs:DescribeTaskDefinition",
          "cloudformation:GetTemplate",
        ],
        resources: ["*"],
      }),
    );

    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [investigatorRole.roleArn],
      }),
    );
    reportsTopic.grantPublish(buildRole);
    claudeToken.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`,
        ],
      }),
    );

    // --- CodeBuild project: runs the headless investigation -----------------
    const project = new codebuild.Project(this, "Investigator", {
      projectName: "poirot-investigator",
      role: buildRole,
      source: codebuild.Source.gitHub({
        owner: props.repoOwner,
        repo: props.repoName,
      }),
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      timeout: cdk.Duration.minutes(30),
      environmentVariables: {
        INVESTIGATOR_ROLE_ARN: { value: investigatorRole.roleArn },
        REPORT_SNS_TOPIC_ARN: { value: reportsTopic.topicArn },
        ...(props.claudeModel ? { CLAUDE_MODEL: { value: props.claudeModel } } : {}),
      },
    });

    // --- Trigger Lambda: SNS alarm -> StartBuild ---------------------------
    const trigger = new lambdaNode.NodejsFunction(this, "Trigger", {
      entry: path.join(REPO_ROOT, "infra", "lambda", "trigger.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PROJECT_NAME: project.projectName,
        // ReportsTopic ARN so the trigger can publish the "investigating" ack
        // and the duplicate/circuit-open suppression notices (operators see
        // Poirot's state instead of silence).
        REPORT_SNS_TOPIC_ARN: reportsTopic.topicArn,
      },
    });
    trigger.addToRolePolicy(
      new iam.PolicyStatement({
        // StartBuild and ListBuildsForProject operate on the *project* ARN.
        actions: ["codebuild:StartBuild", "codebuild:ListBuildsForProject"],
        resources: [project.projectArn],
      }),
    );
    // BatchGetBuilds operates on *build* ARNs, not the project ARN — scoping it
    // to projectArn gives AccessDenied, which the old code swallowed, silently
    // disabling dedup. Scope it to the build ARN wildcard for this project.
    trigger.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:BatchGetBuilds"],
        resources: [
          `arn:${this.partition}:codebuild:${this.region}:${this.account}:build/${project.projectName}:*`,
        ],
      }),
    );
    // Trigger publishes ack / suppression notices to ReportsTopic.
    reportsTopic.grantPublish(trigger);

    // --- DLQ on the alarm SNS subscription ---------------------------------
    // If StartBuild throws (concurrent-build limit, transient AWS error) the
    // SNS message would otherwise be dropped silently — Poirot just doesn't
    // run and nobody knows. Route undeliverable messages to an SQS DLQ and
    // alarm on its depth so operators can replay or investigate.
    const triggerDlq = new sqs.Queue(this, "TriggerDLQ", {
      queueName: "poirot-trigger-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });
    alarmTopic.addSubscription(
      new subs.LambdaSubscription(trigger, { deadLetterQueue: triggerDlq }),
    );

    // --- Self-monitoring: alarms that *watch Poirot itself* ---------------
    // All publish to ReportsTopic (not AlarmTopic) so they notify operators
    // without feedback-looping back into Poirot and burning subscription turns.
    const notifyOps = (name: string, metric: cloudwatch.IMetric, description: string) =>
      new cloudwatch.Alarm(this, name, {
        alarmName: `poirot-${name}`,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(new cw_actions.SnsAction(reportsTopic));

    notifyOps(
      "TriggerLambdaErrors",
      trigger.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      "Poirot's trigger Lambda is itself erroring — alarms may not be dispatching investigations.",
    );
    notifyOps(
      "TriggerLambdaThrottles",
      trigger.metricThrottles({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      "Poirot's trigger Lambda is being throttled — alarms may not be dispatching investigations.",
    );
    notifyOps(
      "TriggerDLQDepth",
      triggerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      "Poirot trigger SNS subscription is dropping alarm messages to the DLQ — investigations are being missed.",
    );
    notifyOps(
      "InvestigatorFailedBuilds",
      project.metricFailedBuilds({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      "Poirot investigations themselves are failing in CodeBuild — reports are not being produced.",
    );

    // Export AlarmTopic ARN as SSM param so other stacks can reference it without coupling.
    new ssm.StringParameter(this, "AlarmTopicParam", {
      parameterName: "/poirot/alarm-topic-arn",
      stringValue: alarmTopic.topicArn,
      description: "Poirot AlarmTopic ARN — point CloudWatch alarm actions here.",
    });

    // --- Optional example: wire an error-spike alarm to the alarm topic -----
    if (props.targetLogGroupName) {
      const targetLg = logs.LogGroup.fromLogGroupName(
        this,
        "TargetLogGroup",
        props.targetLogGroupName,
      );

      const errorFilter = targetLg.addMetricFilter("ErrorSpikeFilter", {
        filterPattern: logs.FilterPattern.anyTerm("ERROR", "Error", "Exception", "FATAL"),
        metricNamespace: "Poirot",
        metricName: "ErrorCount",
        metricValue: "1",
        defaultValue: 0,
      });

      const alarm = new cloudwatch.Alarm(this, "ErrorSpikeAlarm", {
        alarmName: `poirot-error-spike-${props.targetLogGroupName}`.replace(/[^\w-]/g, "-"),
        metric: errorFilter.metric({
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "Error-log spike detected; dispatch Poirot.",
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
    }

    // --- GitHub Actions OIDC: deploy role for CI/CD --------------------------
    const githubProvider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: "poirot-github-deploy",
      description: "Assumed by GitHub Actions (OIDC) to run `cdk deploy` for this stack.",
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${props.repoOwner}/${props.repoName}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    // CDK deploys via its own bootstrap roles (file-publishing, deploy, lookup) —
    // the GitHub role only needs to assume those, not broad account permissions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*-${this.account}-${this.region}`],
      }),
    );

    // --- Outputs ------------------------------------------------------------
    new cdk.CfnOutput(this, "ProjectName", { value: project.projectName });
    new cdk.CfnOutput(this, "GitHubDeployRoleArn", { value: deployRole.roleArn });
    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: alarmTopic.topicArn,
      description: "Point your CloudWatch alarm actions here to dispatch Poirot.",
    });
    new cdk.CfnOutput(this, "ReportsTopicArn", {
      value: reportsTopic.topicArn,
      description: "Subscribe (email/Slack/etc.) to receive Poirot's reports.",
    });
    new cdk.CfnOutput(this, "ClaudeSecretName", { value: claudeToken.secretName });
    new cdk.CfnOutput(this, "InvestigatorRoleArn", { value: investigatorRole.roleArn });
  }
}
