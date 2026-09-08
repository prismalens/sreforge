#!/usr/bin/env bash
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"

MODEL="${AGY_MODEL:-Claude Opus 4.6 (Thinking)}"
PROVIDER="${PROVIDER:-antigravity}"

SKIP_PROBE=false
for arg in "$@"; do
  case "$arg" in
    --skip-probe)
      SKIP_PROBE=true
      ;;
  esac
done

# 1. srt on PATH and runnable
if ! command -v srt >/dev/null 2>&1; then
  echo "preflight-agy: srt not found on PATH" >&2
  exit 10
fi

if ! timeout 5 srt --help >/dev/null 2>&1; then
  echo "preflight-agy: srt is not runnable" >&2
  exit 10
fi

# 2. agy usable
if [ "$SKIP_PROBE" = true ]; then
  if ! command -v agy >/dev/null 2>&1; then
    echo "preflight-agy: agy not found on PATH" >&2
    exit 11
  fi
else
  if ! command -v agy >/dev/null 2>&1; then
    echo "preflight-agy: agy not found on PATH" >&2
    exit 11
  fi

  PROBE_OUT="$(mktemp)"
  timeout 90 agy --model "$MODEL" --output-format json --print-timeout 60s -p "say ok" \
    > "$PROBE_OUT" 2>"$PROBE_OUT.err"
  RC=$?
  BLOB="$(cat "$PROBE_OUT" "$PROBE_OUT.err" 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  RAW="$(cat "$PROBE_OUT" "$PROBE_OUT.err" 2>/dev/null)"

  # 1. quota reached / exhausted / 429
  if echo "$BLOB" | grep -q "quota" && echo "$BLOB" | grep -qE "reached|resource_exhausted|429"; then
    if [[ "$RAW" =~ [Rr]esets?[[:space:]]+in[[:space:]]+([0-9]+[hms][0-9hms]*) ]]; then
      echo "preflight-agy: agy quota reached (resets in ${BASH_REMATCH[1]})" >&2
    else
      echo "preflight-agy: agy quota reached" >&2
    fi
    rm -f "$PROBE_OUT" "$PROBE_OUT.err"
    exit 12
  fi

  # 2. auth failure
  if echo "$BLOB" | grep -qE "authentication failed|not authenticated|unauthenticated|please log in|please login"; then
    echo "preflight-agy: agy authentication failed" >&2
    rm -f "$PROBE_OUT" "$PROBE_OUT.err"
    exit 11
  fi

  # 3. non-zero exit or envelope .status not SUCCESS
  STATUS=""
  if command -v jq >/dev/null 2>&1; then
    STATUS="$(jq -r '.status // empty' "$PROBE_OUT" 2>/dev/null || true)"
  else
    if grep -q '"status":"SUCCESS"' "$PROBE_OUT" 2>/dev/null; then
      STATUS="SUCCESS"
    fi
  fi

  if [ "$RC" -ne 0 ] || [ "$STATUS" != "SUCCESS" ]; then
    ERR_LINE="$(head -n 1 "$PROBE_OUT.err" 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$ERR_LINE" ]; then
      echo "preflight-agy: agy probe failed: $ERR_LINE" >&2
    else
      echo "preflight-agy: agy probe failed (exit $RC)" >&2
    fi
    rm -f "$PROBE_OUT" "$PROBE_OUT.err"
    exit 15
  fi

  rm -f "$PROBE_OUT" "$PROBE_OUT.err"
fi

# 3. WSL networking mode is NAT
if grep -qi microsoft /proc/version 2>/dev/null; then
  WSL_MODE=""
  if command -v wslinfo >/dev/null 2>&1; then
    WSL_MODE="$(wslinfo --networking-mode 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' || true)"
  fi
  if [ -z "$WSL_MODE" ] && [ -f /etc/wsl.conf ]; then
    WSL_MODE="$(grep -i '^[[:space:]]*networkingMode' /etc/wsl.conf 2>/dev/null | head -n 1 | cut -d= -f2 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' || true)"
  fi

  if [ -z "$WSL_MODE" ]; then
    echo "preflight-agy: cannot determine WSL networking mode" >&2
    exit 13
  fi

  if [ "$WSL_MODE" = "mirrored" ]; then
    echo "preflight-agy: WSL networking mode is mirrored (NAT required for srt egress)" >&2
    exit 13
  fi
fi

# 4. PROVIDER resolvable
if [ -z "$PROVIDER" ]; then
  echo "preflight-agy: empty PROVIDER name" >&2
  exit 14
fi

if ! node "$REPO_ROOT/tools/provider-egress.mjs" "$PROVIDER" >/dev/null 2>&1; then
  echo "preflight-agy: unknown PROVIDER '$PROVIDER'" >&2
  exit 14
fi

echo "preflight-agy: ok (srt, agy, wsl, provider)"
exit 0
