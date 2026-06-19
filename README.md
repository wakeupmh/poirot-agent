# poirot-agent

Headless **[pi](https://github.com/earendil-works/pi)** running **Kimi** on shared
AWS compute, dispatched when a log-error spike or production incident fires. Poirot
investigates under a **read-only** IAM role and writes a root-cause report.

It's the "headless coding agent on shared cloud compute a team can trigger" pattern
(inspired by [`headless-claude-on-aws`](https://github.com/deeheber/headless-claude-on-aws)),
adapted to: **incident investigation**, **pi + Kimi** instead of Claude Code, and
**TypeScript** (AWS CDK for infra, a TS runner that drives pi).

## How it works

```
CloudWatch alarm (error-spike metric filter)
        │  alarm action
        ▼
   SNS  (AlarmTopic)
        │
        ▼
  Trigger Lambda  ──StartBuild──▶  CodeBuild project "poirot-investigator"
                                          │
                                          │  install pi, configure Kimi, run TS runner
                                          ▼
                                   pi --mode json   (the brain: Kimi 2.7)
                                          │  bash → AWS CLI, under the
                                          ▼  read-only investigator role
                                   CloudWatch Logs Insights / metrics / deploys
                                          │
                                          ▼
                                   Root-cause report ──▶ build log + SNS (ReportsTopic)
```

- **Agent runtime:** `pi --mode json` (headless). The TS runner (`src/investigate.ts`)
  builds the prompt, spawns pi, parses its JSON event stream, and extracts Poirot's
  final report.
- **Model:** Kimi (Moonshot), configured via pi's `~/.pi/agent/models.json` as an
  OpenAI-compatible provider. Set your exact model id with `KIMI_MODEL`.
- **Tools:** pi's bash tool running the AWS CLI — no MCP server, no custom SDK tools.
- **Security:** dual IAM roles. The build role can only assume the read-only
  investigator role, publish reports, and read the Kimi key. pi's AWS calls run as
  the investigator role (`ReadOnlyAccess`), so it physically cannot change anything.

## Layout

| Path | What |
|------|------|
| `system-prompt.md` | Poirot's persona, investigation method, and hard rules |
| `src/prompt.ts` | Reads the investigation context from env; builds the prompt |
| `src/pi.ts` | Spawns `pi --mode json`, parses the event stream into a report |
| `src/investigate.ts` | Entrypoint: run the investigation, print + publish the report |
| `buildspec.yml` | CodeBuild: install pi, configure Kimi, run the TS runner |
| `infra/lib/poirot-stack.ts` | CDK: CodeBuild, dual roles, SNS, trigger Lambda, example alarm |
| `infra/lambda/trigger.ts` | SNS alarm → `StartBuild` with env overrides |

## Deploy

Prerequisites: an AWS account (bootstrapped for CDK), a Kimi/Moonshot API key, and a
GitHub source credential for CodeBuild (one-time, so it can clone this repo):

```bash
aws codebuild import-source-credentials \
  --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token "$GITHUB_PAT"
```

Then:

```bash
npm install
npm run deploy            # cdk deploy PoirotStack
```

Point the Kimi model and base URL at your provider via `cdk.json` context or flags:

```bash
npm run deploy -- -c kimiModel=kimi-k2.5 -c kimiBaseUrl=https://api.moonshot.ai/v1
```

To wire the included example error-spike alarm to one of your log groups:

```bash
npm run deploy -- -c targetLogGroupName=/aws/lambda/my-service
```

After deploy, populate the secret and subscribe to reports:

```bash
aws secretsmanager put-secret-value \
  --secret-id poirot-agent/kimi-key --secret-string "$KIMI_API_KEY"

aws sns subscribe --protocol email \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name PoirotStack \
    --query "Stacks[0].Outputs[?OutputKey=='ReportsTopicArn'].OutputValue" --output text)" \
  --notification-endpoint you@example.com
```

## Run an investigation manually

```bash
aws codebuild start-build --project-name poirot-investigator \
  --environment-variables-override \
    name=TRIGGER,value="checkout 5xx spike" \
    name=LOG_GROUPS,value="/aws/ecs/checkout,/aws/lambda/checkout-api" \
    name=SERVICE,value="checkout"
```

Or let alarms do it: set any CloudWatch alarm's action to the **AlarmTopic** ARN from
the stack outputs. The trigger Lambda turns the alarm into an investigation, pulling
`LOG_GROUPS`/`SERVICE` from the alarm's metric dimensions when present.

## Environment variables (per investigation)

| Var | Required | Meaning |
|-----|----------|---------|
| `TRIGGER` | yes | Alarm name / incident title |
| `LOG_GROUPS` | no | Comma-separated candidate log groups |
| `SERVICE` | no | Service/app name to narrow the search |
| `WINDOW_START` / `WINDOW_END` | no | ISO-8601 window (defaults to the last hour) |
| `RAW_PAYLOAD` | no | Raw alarm/incident JSON, passed through for context |

Stack-level vars (`INVESTIGATOR_ROLE_ARN`, `REPORT_SNS_TOPIC_ARN`, `KIMI_BASE_URL`,
`KIMI_MODEL`) are set by CDK; the Kimi key comes from Secrets Manager.

## Local dev

```bash
npm install
npm run typecheck
# Drive a single investigation locally (needs pi on PATH + KIMI_API_KEY + AWS creds):
TRIGGER="local test" LOG_GROUPS="/aws/lambda/foo" npm run investigate
```
