#!/usr/bin/env bash
# fault.sh <scenario> on|off. On: commit the scenario's changes onto `healthy` in the booklogr
# checkout, redeploy, seed, start load, wait for the alert. Off: back to `healthy` with a fresh DB.
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIOS="$(cd "$STACK/../.." && pwd)/scenarios"
WORK="$STACK/substrate/booklogr"
STATE="$STACK/.fault"
RUNTIME_ENV_FILE="$STACK/compose/.env"
compose() { docker compose -f "$STACK/compose/docker-compose.yml" "$@"; }

usage() { echo "usage: fault.sh <scenario> on|off   (scenarios: $(ls "$SCENARIOS" | tr '\n' ' '))" >&2; exit 2; }
ID="${1:-}"; ACTION="${2:-}"
[ -n "$ID" ] && [ -f "$SCENARIOS/$ID/fault.env" ] || usage
case "$ACTION" in on|off) ;; *) usage ;; esac
git -C "$WORK" rev-parse --verify --quiet healthy >/dev/null 2>&1 || { echo "no booklogr checkout; run: task up" >&2; exit 1; }

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' booklogr-api 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  echo "booklogr-api did not become healthy within 180s" >&2; exit 1
}

fault_off() {
  echo "==> stopping load"
  compose --profile load rm -sf load >/dev/null 2>&1 || true
  echo "==> booklogr checkout back to healthy"
  git -C "$WORK" checkout --quiet -B main healthy
  git -C "$WORK" clean -fdq
  : > "$RUNTIME_ENV_FILE"
  echo "==> fresh database"
  compose rm -sf booklogr-db >/dev/null
  docker volume rm -f booklogr_pgdata >/dev/null
  compose up -d --build --force-recreate booklogr-db book-metadata booklogr-api
  wait_healthy
  rm -f "$STATE"
}

commit_change() { # N
  local change="$SCENARIOS/$ID/$(eval echo "\$CHANGE_$1")" msg author date name email ts
  msg="$(eval echo "\$MESSAGE_$1")"; author="$(eval echo "\$AUTHOR_$1")"; date="$(eval echo "\$DATE_$1")"
  name="${author% <*}"; email="${author##*<}"; email="${email%>}"
  case "$change" in
    *.patch) git -C "$WORK" apply --whitespace=nowarn "$change" ;;
    *.sh) (cd "$WORK" && bash "$change") ;;
    *) echo "unknown change type: $change" >&2; exit 1 ;;
  esac
  if [ "$date" = now ]; then ts="$(date +%s)"; else ts="$(date -d "$date" +%s)"; fi
  git -C "$WORK" add -A
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
  GIT_AUTHOR_DATE="@$ts" GIT_COMMITTER_DATE="@$ts" git -C "$WORK" commit --quiet -m "$msg"
  echo "    $(git -C "$WORK" log -1 --format='%h %ad %an: %s' --date=short)"
}

fault_on() {
  set -a; . "$SCENARIOS/$ID/fault.env"; set +a
  [ -f "$STATE" ] && fault_off
  echo "==> committing $ID onto healthy"
  git -C "$WORK" checkout --quiet -B main healthy
  local n=1
  while [ -n "$(eval echo "\${CHANGE_$n:-}")" ]; do commit_change "$n"; n=$((n + 1)); done
  printf '%s\n' ${RUNTIME_ENV:-} > "$RUNTIME_ENV_FILE"
  echo "==> redeploying booklogr-api"
  compose up -d --build --force-recreate book-metadata booklogr-api
  wait_healthy
  [ -z "${SEED_COUNT:-}" ] || bash "$STACK/scripts/seed-library.sh" "$SEED_COUNT"
  echo "==> starting load ($STORM at $RATE rps)"
  STORM="$STORM" RATE="$RATE" compose --profile load up -d --force-recreate load
  echo "$ID $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"
  echo "==> waiting for $ALERT"
  node "$STACK/scripts/wait-alert.mjs" "$ALERT" 300
}

if [ "$ACTION" = on ]; then fault_on; else fault_off; fi
