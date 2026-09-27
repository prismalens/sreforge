#!/usr/bin/env bash
# Bring the env up: code checkouts, the agent webhook files, the compose stack (load stays off).
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose -f "$STACK/compose/docker-compose.yml" "$@"; }

bash "$STACK/scripts/setup.sh"

mkdir -p "$STACK/.secrets"
printf '%s' "${AGENT_WEBHOOK_URL:-http://host.docker.internal:3001/api/webhooks/prometheus}" > "$STACK/.secrets/webhook-url"
token="${AGENT_WEBHOOK_TOKEN:-}"
[ -n "$token" ] || [ -z "${AGENT_WEBHOOK_TOKEN_FILE:-}" ] || token="$(cat "$AGENT_WEBHOOK_TOKEN_FILE")"
printf '%s' "$token" > "$STACK/.secrets/webhook-token"
[ -n "$token" ] || echo "note: no AGENT_WEBHOOK_TOKEN or AGENT_WEBHOOK_TOKEN_FILE; alerts are posted without a bearer token"
touch "$STACK/compose/.env"

compose up -d --build
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' booklogr-api 2>/dev/null)" = healthy ] && break
  sleep 3
done
node "$STACK/scripts/status.mjs"
