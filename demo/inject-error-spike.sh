#!/usr/bin/env bash
set -euo pipefail

# Pumps a burst of realistic ERROR log lines into a CloudWatch Logs log group
# so Poirot's example error-spike alarm trips live — for demoing the full
# pipeline (metric filter -> alarm -> SNS -> Lambda -> CodeBuild -> Claude
# Code -> report) on stage. Needs only the AWS CLI, already authenticated.
#
# Usage:
#   demo/inject-error-spike.sh [log-group] [count] [scenario]
#
# scenario: db-pool (default) | oom | timeout
#
# The stack's example alarm (deployed with `-c targetLogGroupName=<log-group>`)
# fires at >=10 matching lines within a 5-minute window, so the default count
# of 15 comfortably trips it.

LOG_GROUP="${1:-/poirot/demo}"
COUNT="${2:-15}"
SCENARIO="${3:-db-pool}"
STREAM="poirot-demo-$(date +%s)"

case "$SCENARIO" in
  db-pool)
    MESSAGE='FATAL: remaining connection slots are reserved for non-replication superuser connections (pool_size=5, active=5)'
    ;;
  oom)
    MESSAGE='FATAL: JavaScript heap out of memory - Reached heap limit Allocation failed - process out of memory'
    ;;
  timeout)
    MESSAGE='ERROR: upstream request to payments-gateway timed out after 30000ms'
    ;;
  *)
    echo "Unknown scenario '$SCENARIO' (expected db-pool | oom | timeout)" >&2
    exit 1
    ;;
esac

echo "Log group: $LOG_GROUP"
echo "Stream:    $STREAM"
echo "Scenario:  $SCENARIO"
echo "Lines:     $COUNT"
echo

aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs create-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$STREAM"

now_ms=$(($(date +%s) * 1000))
events="["
for ((i = 0; i < COUNT; i++)); do
  ts=$((now_ms + i * 200))
  events+="{\"timestamp\":${ts},\"message\":\"${MESSAGE}\"}"
  if ((i < COUNT - 1)); then events+=","; fi
done
events+="]"

aws logs put-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$STREAM" \
  --log-events "$events" >/dev/null

echo "✅ Injected $COUNT error lines into $LOG_GROUP/$STREAM"
echo "   The metric filter evaluates every 5 minutes — the alarm should trip"
echo "   on the next evaluation, dispatching Poirot within a few minutes."
