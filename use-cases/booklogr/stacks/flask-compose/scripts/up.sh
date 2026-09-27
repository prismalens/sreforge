#!/usr/bin/env bash
# Bring the env up: booklogr checkout, prismalens webhook files, the compose stack (load stays off).
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose -f "$STACK/compose/docker-compose.yml" "$@"; }

bash "$STACK/scripts/setup.sh"

mkdir -p "$STACK/.secrets"
printf '%s' "${PRISMALENS_WEBHOOK_URL:-http://host.docker.internal:3001/api/webhooks/prometheus}" > "$STACK/.secrets/prismalens-url"
token="${PRISMALENS_TOKEN:-}"
[ -n "$token" ] || [ -z "${PRISMALENS_TOKEN_FILE:-}" ] || token="$(cat "$PRISMALENS_TOKEN_FILE")"
printf '%s' "$token" > "$STACK/.secrets/prismalens-token"
[ -n "$token" ] || echo "warning: no PRISMALENS_TOKEN or PRISMALENS_TOKEN_FILE; prismalens will reject the webhook"
touch "$STACK/compose/.env"

compose up -d --build
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' booklogr-api 2>/dev/null)" = healthy ] && break
  sleep 3
done
node "$STACK/scripts/status.mjs"
