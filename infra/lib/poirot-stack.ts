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
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface PoirotStackProps extends cdk.StackProps {
  /** GitHub owner that hosts this repo (CodeBuild clones it to run buildspec.yml). */
  repoOwner: string;
  /** GitHub repo name. */
  repoName: string;
  /** Kimi (Moonshot) OpenAI-compatible base URL. */
  kimiBaseUrl: string;
  /** Kimi model id to send to the API (set this to your exact Kimi 2.7 id). */
  kimiModel: string;
  /** Optional: existing log group to attach an example error-spike alarm to. */
  targetLogGroupName?: string;
}

const REPO_ROOT = path.join(__dirname, "..", "..");

export class PoirotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PoirotStackProps) {
    super(scope, id, props);

    // --- Secret: the Kimi API key (populate after deploy) -------------------
    const kimiKey = new secrets.Secret(this, "KimiKey", {
      secretName: "poirot-agent/kimi-key",
      description: "Kimi (Moonshot) API key used by pi. Populate after deploy.",
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

    // 2) Investigator role: what pi actually uses — strictly read-only.
    const investigatorRole = new iam.Role(this, "InvestigatorRole", {
      assumedBy: new iam.ArnPrincipal(buildRole.roleArn),
      description: "Read-only role pi assumes to investigate. Cannot mutate anything.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"),
      ],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [investigatorRole.roleArn],
      }),
    );
    reportsTopic.grantPublish(buildRole);
    kimiKey.grantRead(buildRole);
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
        KIMI_BASE_URL: { value: props.kimiBaseUrl },
        KIMI_MODEL: { value: props.kimiModel },
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
      },
    });
    trigger.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:StartBuild"],
        resources: [project.projectArn],
      }),
    );
    alarmTopic.addSubscription(new subs.LambdaSubscription(trigger));

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

    // --- Outputs ------------------------------------------------------------
    new cdk.CfnOutput(this, "ProjectName", { value: project.projectName });
    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: alarmTopic.topicArn,
      description: "Point your CloudWatch alarm actions here to dispatch Poirot.",
    });
    new cdk.CfnOutput(this, "ReportsTopicArn", {
      value: reportsTopic.topicArn,
      description: "Subscribe (email/Slack/etc.) to receive Poirot's reports.",
    });
    new cdk.CfnOutput(this, "KimiSecretName", { value: kimiKey.secretName });
    new cdk.CfnOutput(this, "InvestigatorRoleArn", { value: investigatorRole.roleArn });
  }
}
