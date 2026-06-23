# 🕵️ poirot-agent

> **A coding agent that gets paged instead of a human — and investigates the incident under a read-only lock.**

Poirot is **Claude Code running headless on shared AWS compute**. When a
CloudWatch alarm fires on a log-error spike, Poirot is dispatched automatically,
investigates the incident **read-only**, and writes a grounded root-cause report
to your inbox. It diagnoses; it never touches production.

It's the *"headless coding agent on shared cloud compute that a whole team can
trigger"* pattern — inspired by
[`headless-claude-on-aws`](https://github.com/deeheber/headless-claude-on-aws) —
pointed at **incident response** and written in **TypeScript** (AWS CDK + a thin
runner that drives Claude Code).

---

## The idea in one picture

```
   CloudWatch alarm  (error-spike metric filter)
          │  alarm action
          ▼
        SNS · AlarmTopic
          │
          ▼
    Trigger Lambda ──StartBuild──▶  CodeBuild · "poirot-investigator"
                                          │
                                          │  installs Claude Code, runs the TS runner
                                          ▼
                                 claude -p  (headless, stream-json)
                                          │  Bash → AWS CLI
                                          ▼  ── under the READ-ONLY investigator role ──
                          CloudWatch Logs Insights · metrics · deploy history
                                          │
                                          ▼
                              Root-cause report ──▶ build log + SNS · ReportsTopic ──▶ 📧
```

**No human in the loop until the report lands.** An alarm becomes an
investigation; an investigation becomes a report.

---

## Why this is interesting (the talk track)

Three design choices do the heavy lifting — each is a slide on its own:

### 1. The agent is structurally incapable of causing harm
Poirot runs under a **dedicated read-only IAM role**, separate from the role that
launches it. Even if the model is confused, prompt-injected by a malicious log
line, or simply wrong, it **cannot** create, modify, restart, scale, or delete
anything — the credentials don't allow it. Safety is enforced by IAM, not by
asking the model nicely.

```
build role        →  can ONLY: assume the investigator role, publish a report,
                      read the Claude token            (least privilege)
investigator role →  ReadOnlyAccess — what Claude's AWS CLI calls actually run as
                      ...minus an explicit DENY on secrets, SSM params, KMS
                      decrypt, S3 object reads, and DynamoDB data
```

Read-only isn't enough on its own: Poirot reads **untrusted log content** (a
prompt-injection surface) and then publishes a report, so a crafted log line
must not be able to talk it into reading a secret and leaking it. An explicit
**deny** on the high-value data reads closes that door — it can investigate
*infrastructure* (logs, metrics, deploys, config) but cannot read your *data*.

This is the crux of trusting an autonomous agent in production: **you don't trust
the agent, you trust the blast-radius wall around it.**

### 2. It bills against a subscription, not per token
Claude Code authenticates with a **Claude Pro/Max subscription token**
(`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`). Investigations draw down
your plan at a **flat cost** — no per-incident API metering, no surprise bill
when a noisy night fires fifty alarms.

### 3. Incident response is a near-perfect agent task
It's **read-heavy, bounded, and repetitive** — exactly what burns out on-call
engineers and exactly where an agent shines: pull the error signatures, correlate
with the last deploy, size the blast radius, write it up. Poirot does the first
30 minutes of every investigation so a human starts from a hypothesis instead of
a blank terminal.

---

## What a report looks like

Poirot always finishes with one self-contained report (structure enforced by
[`system-prompt.md`](system-prompt.md)):

```
## Incident summary
checkout-api 5xx rate jumped from ~0.1% to 18% at 14:02 UTC and is ongoing.

## Root cause
Deploy `d-AB12CD` (14:01 UTC) shipped a config change that points the service at
a connection pool of 5; under normal traffic it exhausts immediately, surfacing
as "FATAL: remaining connection slots are reserved".

## Evidence
- Logs Insights: 9,412 × "remaining connection slots are reserved", first seen 14:02:11 — zero before 14:02.
- CodeDeploy: deployment d-AB12CD completed 14:01:48, one minute before onset.
- CloudWatch: DatabaseConnections flatlined at the new ceiling from 14:02.

## Blast radius
All checkout traffic in us-east-1; ~18% of requests failing. Read paths unaffected.

## Confidence
high — the deploy timestamp, the new error signature, and the connection ceiling all line up.

## Recommended next steps
1. Roll back d-AB12CD or raise the pool size.
2. Add a pre-deploy check on the pool-size config.
```

---

## How it works

| Stage | What happens |
|-------|--------------|
| **Trigger** | A CloudWatch alarm (e.g. an error-spike metric filter) fires its action to the `AlarmTopic`. A small Lambda turns the alarm into a `StartBuild`, lifting `LOG_GROUPS`/`SERVICE` from the alarm's metric dimensions when present. |
| **Runtime** | CodeBuild installs Claude Code and runs the TS runner, which builds the prompt, spawns `claude -p --output-format stream-json`, and parses the event stream for Poirot's final report. |
| **Tools** | Claude Code's **Bash** tool running the **AWS CLI** — no MCP server, no custom SDK tools. Logs Insights, metrics, and deploy history are all just CLI calls. |
| **Output** | The report is printed to the build log and published to the `ReportsTopic` (subscribe email, Slack, PagerDuty, …). |

### The detective's method
Poirot works the case in a fixed order — establish the facts, read the actual
error lines, correlate with recent deploys/changes, size the blast radius, then
form and *try to disprove* a hypothesis before committing. Every claim is tied to
a log line, metric, or deploy event it actually retrieved. The full method and
hard rules live in [`system-prompt.md`](system-prompt.md).

---

## Repository layout

| Path | What |
|------|------|
| `system-prompt.md` | Poirot's persona, investigation method, and hard rules |
| `src/prompt.ts` | Reads the investigation context from env; builds the system + case prompts |
| `src/claude.ts` | Spawns `claude -p`, parses the stream-json events into a report |
| `src/investigate.ts` | Entrypoint: run the investigation, print + publish the report |
| `buildspec.yml` | CodeBuild: install Claude Code, run the TS runner |
| `infra/lib/poirot-stack.ts` | CDK: CodeBuild, dual IAM roles, SNS topics, trigger Lambda, example alarm |
| `infra/lambda/trigger.ts` | SNS alarm → `StartBuild` with per-incident env overrides |

---

## Deploy

**Prerequisites:** an AWS account (CDK-bootstrapped), a Claude Pro/Max
subscription, and a one-time GitHub source credential so CodeBuild can clone:

```bash
aws codebuild import-source-credentials \
  --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token "$GITHUB_PAT"
```

```bash
npm install
npm run deploy            # cdk deploy PoirotStack
```

After deploy, mint a subscription token, store it, and subscribe to reports:

```bash
claude setup-token        # long-lived token tied to your Pro/Max plan

aws secretsmanager put-secret-value \
  --secret-id poirot-agent/claude-token --secret-string "$CLAUDE_CODE_OAUTH_TOKEN"

aws sns subscribe --protocol email \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name PoirotStack \
    --query "Stacks[0].Outputs[?OutputKey=='ReportsTopicArn'].OutputValue" --output text)" \
  --notification-endpoint you@example.com
```

Optional — pin a model, or wire the example error-spike alarm to one of your log groups:

```bash
npm run deploy -- -c claudeModel=sonnet
npm run deploy -- -c targetLogGroupName=/aws/lambda/my-service
```

---

## Run an investigation

**Manually:**

```bash
aws codebuild start-build --project-name poirot-investigator \
  --environment-variables-override \
    name=TRIGGER,value="checkout 5xx spike" \
    name=LOG_GROUPS,value="/aws/ecs/checkout,/aws/lambda/checkout-api" \
    name=SERVICE,value="checkout"
```

**Automatically:** point any CloudWatch alarm's action at the **AlarmTopic** ARN
from the stack outputs. The trigger Lambda does the rest.

### Per-investigation inputs

| Var | Required | Meaning |
|-----|----------|---------|
| `TRIGGER` | ✅ | Alarm name / incident title |
| `LOG_GROUPS` | | Comma-separated candidate log groups |
| `SERVICE` | | Service/app name to narrow the search |
| `WINDOW_START` / `WINDOW_END` | | ISO-8601 window (defaults to the last hour) |
| `RAW_PAYLOAD` | | Raw alarm/incident JSON, passed through for context |
| `CLAUDE_MODEL` | | Model override (else the account default) |
| `CLAUDE_MAX_TURNS` | | Cap on agent turns (default 40) |

Stack-level vars (`INVESTIGATOR_ROLE_ARN`, `REPORT_SNS_TOPIC_ARN`) are set by CDK;
the Claude token arrives from Secrets Manager as `CLAUDE_CODE_OAUTH_TOKEN`.

---

## Token lifecycle

`claude setup-token` is the **long-lived, headless** credential — the same path
Anthropic's own `claude-code-action` uses. The token is tied to your plan and
lasts on the order of months (up to ~a year), so day to day there's nothing to
manage. When it eventually expires you'll see an auth error in the build log;
rotate it in place, no redeploy:

```bash
claude setup-token
aws secretsmanager put-secret-value \
  --secret-id poirot-agent/claude-token --secret-string "$CLAUDE_CODE_OAUTH_TOKEN"
```

> A zero-touch variant is possible — persist Claude Code's auto-refreshed OAuth
> credentials back to Secrets Manager after each build. It needs
> `secretsmanager:PutSecretValue` on the build role and serialized builds
> (`concurrentBuildLimit: 1`) to avoid refresh-token races, so it's intentionally
> left out in favour of the simpler rotate-when-it-expires approach.

---

## Design decisions (FAQ / Q&A)

**Why a separate read-only role instead of just trusting the prompt?**
Because prompts are not a security boundary. A malicious string in a log line
could try to talk the agent into running a mutating command. IAM is the boundary;
the agent literally lacks the permission, so it doesn't matter what it's told.

**Why subscription billing rather than an API key?**
An API key bills per token — fine, but unpredictable when alarm storms hit. A
subscription token is flat cost and the same credential Claude Code is designed
to run headless with. Swapping to an API key is a one-line secret change if you'd
rather meter per token.

**Why the AWS CLI over an AWS MCP server?**
Fewer moving parts. The CLI is already authoritative, every read maps to an IAM
action the investigator role can be scoped to, and there's nothing extra to
install or keep in sync. MCP is a clean upgrade path if you want richer tooling.

**Why CodeBuild instead of Lambda?**
Investigations are long, bursty, and need a real shell with the AWS CLI and
Node toolchain. CodeBuild gives that with no idle cost and natural concurrency.

**What stops it running forever / racking up cost?**
`CLAUDE_MAX_TURNS` (default 40) bounds the agent, and CodeBuild's own timeout
bounds the build.

---

## Local development

```bash
npm install
npm run typecheck
# Drive one investigation locally — needs Claude Code on PATH, an authed Claude
# session (or CLAUDE_CODE_OAUTH_TOKEN), and AWS credentials:
TRIGGER="local test" LOG_GROUPS="/aws/lambda/foo" npm run investigate
```
