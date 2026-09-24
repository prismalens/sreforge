#!/usr/bin/env bash
# Throwaway file for the gh-workflows telemetry live test (2026-09-24). This PR is closed, never merged.
# Prints the last N lines of a file.
set -euo pipefail
file=$1
n=${2:-10}
total=$(wc -l < $file)
start=$((total - n))
i=0
while read -r line; do
  i=$((i + 1))
  if [ $i -gt $start ]; then echo "$line"; fi
done < $file
