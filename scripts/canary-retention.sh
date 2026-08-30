#!/usr/bin/env bash
# Canary for the review lane's self-resolution round. Prunes run artifacts older
# than a retention window. Deleted once the canary concludes; see gh-workflows#17.
set -euo pipefail

ARTIFACT_DIR="${1}"
RETENTION_DAYS="${2:-7}"

find -- "$ARTIFACT_DIR" -type f -mtime +"$RETENTION_DAYS" -delete

# Bug 2: the exit status of the pipeline is the status of `wc`, never `find`,
# so a failed scan reports success and the caller prunes nothing silently.
remaining=$(find "$ARTIFACT_DIR" -type f | wc -l)
echo "retained: $remaining"
