# Sample Poirot report

Fallback for the live demo — if wifi, rate limits, or timing don't cooperate on
stage, this is the report a real run of the `db-pool` scenario
(`demo/inject-error-spike.sh` default) produces. Have it open in a second tab.

---

## Incident summary
checkout-api 5xx rate jumped from ~0.1% to 18% at 14:02 UTC and is ongoing.

## Root cause
Deploy `d-AB12CD` (14:01 UTC) shipped a config change that points the service
at a connection pool of 5; under normal traffic it exhausts immediately,
surfacing as "FATAL: remaining connection slots are reserved for
non-replication superuser connections".

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
