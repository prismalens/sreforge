#!/usr/bin/env bash
# agent-agy.sh — Antigravity (agy) driver for the external-agent loop,
# reasoning host-side but CONFINED by anthropic sandbox-runtime (srt):
#   - filesystem: the sreforge workspace is deny-read (answer key invisible)
#   - network:    egress only to the provider domains (fail-closed proxy)
#   - unix sockets: allowed, so `docker exec` into the sealed box still works
#     (Linux seccomp is all-or-nothing; the docker socket is the accepted
#     residual — pair with a socket-proxy if it ever matters)
# AGENT_CMD contract (auto-incident.mjs): WEBHOOK_PAYLOAD env in, submit
# sentinel written in-box on success, exit 0. Requires: srt on PATH
# (npm i -g @anthropic-ai/sandbox-runtime), agy authenticated on the host,
# and WSL in NAT networking mode (mirrored silently kills srt egress).
#
#   AGENT_CMD="bash scripts/agent-agy.sh" pnpm forge auto booklogr
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${AGY_MODEL:-Claude Opus 4.6 (Thinking)}"
U="$(id -u):$(id -g)"
SCRATCH="$(mktemp -d /tmp/agy-incident.XXXXXX)"
LOG="${AGY_LOG:-$SCRATCH/agy-transcript.txt}"
PAYLOAD="${WEBHOOK_PAYLOAD:-An alert is firing for the service.}"

# ---- per-run srt settings: resolve PROVIDER → egress domains -----------------
PROVIDER="${PROVIDER:-antigravity}"

export AGY_MODEL="$MODEL" PROVIDER
bash "$HERE/preflight-agy.sh" || exit $?

if [ -n "${SRT_SETTINGS:-}" ]; then
  # Explicit SRT_SETTINGS wins — skip generation.
  echo "agent-agy: using explicit SRT_SETTINGS=$SRT_SETTINGS"
else
  # Resolve egress allowlist from the provider registry, split into domains,
  # and generate the srt settings JSON in $SCRATCH per run.
  EGRESS_CSV="$(node "$(cd "$HERE/../../../../.." && pwd)/tools/provider-egress.mjs" "$PROVIDER")" || exit 1

  # Build the allowedDomains JSON array from the comma-separated list
  DOMAINS_JSON="["
  first=true
  IFS=',' read -ra DOMAINS <<< "$EGRESS_CSV"
  # scenario.toml [endpoints] are BINDING; without loopback in allowedDomains they return 000.
  DOMAINS+=("localhost" "127.0.0.1")
  for d in "${DOMAINS[@]}"; do
    [ -z "$d" ] && continue
    if [ "$first" = true ]; then first=false; else DOMAINS_JSON+=","; fi
    DOMAINS_JSON+="\"$d\""
  done
  DOMAINS_JSON+="]"

  SRT_SETTINGS="$SCRATCH/srt-settings.json"
  cat > "$SRT_SETTINGS" <<SRTEOF
{
  "network": {
    "allowedDomains": $DOMAINS_JSON,
    "deniedDomains": [],
    "allowUnixSockets": ["/var/run/docker.sock", "/run/docker.sock"],
    "allowAllUnixSockets": true
  },
  "filesystem": {
    "denyRead": [
      "~/sources/sreforge-workspace",
      "~/prismalens-org",
      "~/ai-context",
      "~/mage-memory"
    ],
    "allowWrite": ["/tmp", "~/.gemini"],
    "denyWrite": []
  }
}
SRTEOF
fi

# ---- banner ------------------------------------------------------------------
# Extract domain list for display from the generated settings
if [ -n "${EGRESS_CSV:-}" ]; then
  DISPLAY_DOMAINS="${EGRESS_CSV//,/ }"
else
  DISPLAY_DOMAINS="(from $SRT_SETTINGS)"
fi

echo "╭──────────────────────────────────────────────────────────────╮"
echo "│  confinement: host-sandboxed                                │"
echo "│  provider:    ${PROVIDER}"
echo "│  srt egress allowlist: ${DISPLAY_DOMAINS}"
echo "│  fs deny-read: sreforge workspace                           │"
echo "╰──────────────────────────────────────────────────────────────╯"

cat > "$SCRATCH/prompt.txt" <<EOF
You are an on-call SRE engineer. An incident is affecting a service you operate.

Your ONLY access to the incident host is this exact command shape, run via your shell tool:
  docker exec -u $U -w /workspace agent-shell sh -c '<command>'
Everything about the service lives INSIDE that incident host. This machine is just your terminal: do not read, list, or search any files or directories on it, and do not run anything other than the docker exec commands above. Work only through the incident host.

The alerting stack is the source of truth — start there and let the signals lead you.
Reachable endpoints are provided as env vars inside the host — run: env | grep _URL   (inside the host) to see ALERTMANAGER_URL, PROM_URL, GRAFANA_URL and API_URL, then curl them to investigate.
The service's source is a git checkout at /workspace — read it, find the regression that explains the signals, and fix it in place.
Investigate efficiently: prefer targeted commands (grep -rn, reading specific files, git log) over dumping large directory trees.
So your work is auditable, echo each command before running it.
When you've fixed it, write a brief postmortem — root cause, evidence you used, what you changed — save it to a file (e.g. postmortem.md) and include it when you submit:
  docker exec -u $U -w /workspace agent-shell sh -c 'submit --rca postmortem.md "one-line summary of the fix"'
Keep working until you have submitted.

This alert notification was just delivered to the incident host:
$PAYLOAD

Investigate from the alerting stack, find the root cause in the code, apply a fix in /workspace, and submit.
EOF

cat > "$SCRATCH/inner.sh" <<EOF
cd "$SCRATCH"
# srt injects its own no_proxy covering loopback, which makes clients bypass srt's proxy and
# die on a direct connection. Clearing it routes them back through the proxy. node's fetch
# (undici) ignores proxy env vars entirely unless NODE_USE_ENV_PROXY is set, so any node-based
# tool would still see 000 without it. No new tell: srt already exports ALL_PROXY/HTTP_PROXY.
unset no_proxy NO_PROXY
export NODE_USE_ENV_PROXY=1
exec agy --model "$MODEL" --dangerously-skip-permissions --print-timeout 45m0s -p "\$(cat "$SCRATCH/prompt.txt")"
EOF

srt -s "$SRT_SETTINGS" -c "bash $SCRATCH/inner.sh" 2>&1 | tee "$LOG"

if docker exec agent-shell sh -c 'test -f /workspace/.sreforge/submit.json'; then
  SUBMITTED=true
else
  SUBMITTED=false
fi

# agy is invoked without --continue/--conversation, so this is a fresh conversation context every time.
SESSION="${AGENT_SESSION:-cold}"

# Best-effort: the transcript is a debugging artifact, never the graded evidence
# (the verdict is outcome-based, ADR-0004). This script is `set -u` only, so a
# failure would not abort today — the guard keeps the invariant explicit and
# survives anyone adding `-e` later.
node "$(cd "$HERE/../../../../.." && pwd)/tools/transcript/write-handoff.mjs" \
  --out "$(cd "$HERE/.." && pwd)/.run-workspace/agent-transcript.json" \
  --run-id "${RUN_ID:-run-unknown}" \
  --harness "agy" \
  --session "$SESSION" \
  --confinement "host-sandboxed" \
  --model "$MODEL" \
  --provider "$PROVIDER" \
  --preflight ok \
  --submitted "$SUBMITTED" \
  --raw-text-file "$LOG" \
  || echo "agent-agy: WARNING — transcript handoff failed (continuing; the run is still gradeable)" >&2

RCA_TMP="$SCRATCH/rca.txt"
if docker exec agent-shell cat /workspace/.sreforge/rca.txt > "$RCA_TMP" 2>/dev/null; then
  node "$(cd "$HERE/../../../../.." && pwd)/tools/transcript/write-handoff.mjs" \
    --kind rca \
    --out "$(cd "$HERE/.." && pwd)/.run-workspace/agent-rca.json" \
    --run-id "${RUN_ID:-run-unknown}" \
    --harness "agy" \
    --session "$SESSION" \
    --confinement "host-sandboxed" \
    --model "$MODEL" \
    --provider "$PROVIDER" \
    --preflight ok \
    --submitted "$SUBMITTED" \
    --raw-text-file "$RCA_TMP" \
    || echo "agent-agy: WARNING — rca handoff failed (continuing; the run is still gradeable)" >&2
fi

if [ "$SUBMITTED" = true ]; then
  echo "agent-agy: submit sentinel present — ready to grade. transcript: $LOG"
  exit 0
fi
echo "agent-agy: no submit sentinel — nothing to grade. transcript: $LOG" >&2
exit 2
