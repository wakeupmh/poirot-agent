# poirot-agent

Headless **Claude Code** running on shared AWS compute, dispatched when a
log-error spike or production incident fires. Poirot investigates under a
**read-only** IAM role and writes a root-cause report.

It's the "headless coding agent on shared cloud compute a team can trigger"
pattern (inspired by [`headless-claude-on-aws`](https://github.com/deeheber/headless-claude-on-aws)),
adapted to **incident investigation** and written in **TypeScript** (AWS CDK for
infra, a TS runner that drives Claude Code).

## Billing

Claude Code authenticates with a **Claude Pro/Max subscription token**
(`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), so investigations are
billed against your subscription — not per API token.

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
                                          │  install Claude Code, run TS runner
                                          ▼
                                   claude -p --output-format stream-json
                                          │  Bash → AWS CLI, under the
                                          ▼  read-only investigator role
                                   CloudWatch Logs Insights / metrics / deploys
                                          │
                                          ▼
                                   Root-cause report ──▶ build log + SNS (ReportsTopic)
```

- **Agent runtime:** `claude -p ... --output-format stream-json` (headless). The
  TS runner (`src/investigate.ts`) builds the prompt, spawns Claude Code, parses
  its stream-json events, and extracts Poirot's final report.
- **Tools:** Claude Code's Bash tool running the AWS CLI — no MCP server, no
  custom SDK tools.
- **Security:** dual IAM roles. The build role can only assume the read-only
  investigator role, publish reports, and read the Claude token. Claude's AWS
  calls run as the investigator role (`ReadOnlyAccess`), so it physically cannot
  change anything.

## Layout

| Path | What |
|------|------|
| `system-prompt.md` | Poirot's persona, investigation method, and hard rules |
| `src/prompt.ts` | Reads the investigation context from env; builds prompts |
| `src/claude.ts` | Spawns `claude -p`, parses the stream-json events into a report |
| `src/investigate.ts` | Entrypoint: run the investigation, print + publish the report |
| `buildspec.yml` | CodeBuild: install Claude Code, run the TS runner |
| `infra/lib/poirot-stack.ts` | CDK: CodeBuild, dual roles, SNS, trigger Lambda, example alarm |
| `infra/lambda/trigger.ts` | SNS alarm → `StartBuild` with env overrides |

## Deploy

Prerequisites: an AWS account (bootstrapped for CDK), a Claude Pro/Max
subscription, and a GitHub source credential for CodeBuild (one-time, so it can
clone this repo):

```bash
aws codebuild import-source-credentials \
  --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token "$GITHUB_PAT"
```

Then:

```bash
npm install
npm run deploy            # cdk deploy PoirotStack
```

After deploy, mint a subscription token and store it, then subscribe to reports:

```bash
# Generates a long-lived token tied to your Claude Pro/Max plan.
claude setup-token

aws secretsmanager put-secret-value \
  --secret-id poirot-agent/claude-token --secret-string "$CLAUDE_CODE_OAUTH_TOKEN"

aws sns subscribe --protocol email \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name PoirotStack \
    --query "Stacks[0].Outputs[?OutputKey=='ReportsTopicArn'].OutputValue" --output text)" \
  --notification-endpoint you@example.com
```

Optional: pin a specific Claude model, or wire the example error-spike alarm to
one of your log groups:

```bash
npm run deploy -- -c claudeModel=sonnet
npm run deploy -- -c targetLogGroupName=/aws/lambda/my-service
```

## Run an investigation manually

```bash
aws codebuild start-build --project-name poirot-investigator \
  --environment-variables-override \
    name=TRIGGER,value="checkout 5xx spike" \
    name=LOG_GROUPS,value="/aws/ecs/checkout,/aws/lambda/checkout-api" \
    name=SERVICE,value="checkout"
```

Or let alarms do it: set any CloudWatch alarm's action to the **AlarmTopic** ARN
from the stack outputs. The trigger Lambda turns the alarm into an investigation,
pulling `LOG_GROUPS`/`SERVICE` from the alarm's metric dimensions when present.

## Environment variables (per investigation)

| Var | Required | Meaning |
|-----|----------|---------|
| `TRIGGER` | yes | Alarm name / incident title |
| `LOG_GROUPS` | no | Comma-separated candidate log groups |
| `SERVICE` | no | Service/app name to narrow the search |
| `WINDOW_START` / `WINDOW_END` | no | ISO-8601 window (defaults to the last hour) |
| `RAW_PAYLOAD` | no | Raw alarm/incident JSON, passed through for context |
| `CLAUDE_MODEL` | no | Model override (else the account default) |
| `CLAUDE_MAX_TURNS` | no | Cap on agent turns (default 40) |

Stack-level vars (`INVESTIGATOR_ROLE_ARN`, `REPORT_SNS_TOPIC_ARN`) are set by
CDK; the Claude token comes from Secrets Manager as `CLAUDE_CODE_OAUTH_TOKEN`.

## Local dev

```bash
npm install
npm run typecheck
# Drive a single investigation locally (needs Claude Code on PATH, an authed
# Claude session or CLAUDE_CODE_OAUTH_TOKEN, and AWS creds):
TRIGGER="local test" LOG_GROUPS="/aws/lambda/foo" npm run investigate
```
