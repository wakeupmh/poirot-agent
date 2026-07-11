# Live demo kit

A recipe for demoing the full pipeline live on stage — alarm fires, Poirot
investigates, a report lands — plus a fallback for when a live network
dependency doesn't cooperate mid-talk.

## Before the talk

1. Deploy with the example alarm wired to a scratch log group:

   ```bash
   npm run deploy -- -c targetLogGroupName=/poirot/demo
   ```

2. Subscribe something visible to `ReportsTopicArn` (from the stack outputs) —
   email works, but for a live audience a Slack webhook subscription reads
   better on a shared screen than an inbox.

3. Do one full dry run beforehand — deploys, subscriptions, and CodeBuild's
   image cache all warm up in ways that make the *live* run faster and more
   predictable. See the timing note below.

## During the talk

```bash
demo/inject-error-spike.sh            # db-pool scenario, 15 lines, default log group
demo/inject-error-spike.sh /poirot/demo 15 oom
demo/inject-error-spike.sh /poirot/demo 15 timeout
```

The metric filter evaluates every 5 minutes, so there's a real gap between
injecting and the alarm firing — plan for it in your talk's pacing (cue the
injection *before* the section where you want the report to land, or narrate
through the wait rather than watching a spinner). Once the alarm trips:
`AlarmTopic` → trigger Lambda → `StartBuild` → Claude Code investigates →
report lands on the subscription you set up.

## If it doesn't cooperate live

Wifi, subscription lag, or an alarm-storm dedupe/circuit-breaker suppressing a
repeat run from earlier testing can all get in the way mid-talk. Have
[`sample-report.md`](sample-report.md) open in a tab — it's what a real run of
the `db-pool` scenario produces, ready to show as-is.

## After the talk

```bash
demo/cleanup.sh    # deletes /poirot/demo and everything in it
```
