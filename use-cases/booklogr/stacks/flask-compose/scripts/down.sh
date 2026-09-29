#!/usr/bin/env bash
# Stop everything, drop the volumes, and put the booklogr checkout back on `healthy`.
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$STACK/substrate/booklogr"
docker compose -f "$STACK/compose/docker-compose.yml" --profile load down -v --remove-orphans
rm -f "$STACK/.fault"
: > "$STACK/compose/.env"
if git -C "$WORK" rev-parse --verify --quiet healthy >/dev/null 2>&1; then
  git -C "$WORK" checkout --quiet -B main healthy
  git -C "$WORK" clean -fdq
fi
