#!/usr/bin/env bash
set -euo pipefail

# Deletes the demo log group created by inject-error-spike.sh (and everything
# in it — all its streams). Run this after the talk to tidy up.
#
# Usage: demo/cleanup.sh [log-group]

LOG_GROUP="${1:-/poirot/demo}"

aws logs delete-log-group --log-group-name "$LOG_GROUP" 2>/dev/null \
  && echo "✅ Deleted $LOG_GROUP" \
  || echo "Nothing to delete at $LOG_GROUP (already gone, or check your AWS_REGION/profile)."
