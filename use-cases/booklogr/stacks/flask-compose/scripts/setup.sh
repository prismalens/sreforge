#!/usr/bin/env bash
# Clone booklogr with its real history into substrate/booklogr and build the `healthy` branch
# (upstream + Prometheus metrics + the owner/title index). Idempotent: skips when `healthy` exists.
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$STACK/substrate/booklogr"
UPSTREAM="${UPSTREAM_REPO:-https://github.com/Mozzo1000/booklogr.git}"
UPSTREAM_REF="${UPSTREAM_REF:-}"

if git -C "$WORK" rev-parse --verify --quiet healthy >/dev/null 2>&1; then
  echo "substrate ready: $WORK (healthy = $(git -C "$WORK" rev-parse --short healthy))"
  exit 0
fi

rm -rf "$WORK"
mkdir -p "$STACK/substrate"
git clone --quiet "$UPSTREAM" "$WORK"
[ -z "$UPSTREAM_REF" ] || git -C "$WORK" checkout --quiet "$UPSTREAM_REF"
git -C "$WORK" remote remove origin

NAME="$(git -C "$WORK" log -1 --format=%an)"
EMAIL="$(git -C "$WORK" log -1 --format=%ae)"
commit() { # DATE MESSAGE
  git -C "$WORK" add -A
  GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$WORK" commit --quiet -m "$2"
}

python3 "$STACK/instrumentation/apply.py" "$WORK"
if [ -f "$WORK/poetry.lock" ]; then
  docker run --rm -v "$WORK":/w -w /w python:3.12-slim \
    sh -c 'pip install -q "poetry==1.8.5" && poetry lock --no-update' >/dev/null 2>&1 \
    || echo "warning: poetry lock regen failed; the lockfile may be stale"
fi
commit "2026-06-09 09:47:18 +0200" "Add Prometheus metrics (prometheus-flask-exporter, multiprocess mode)"

mkdir -p "$WORK/migrations/versions"
cp "$STACK"/instrumentation/schema/versions/*_add_books_owner_title_index.py "$WORK/migrations/versions/"
commit "2026-06-10 09:12:41 +0200" "Add owner/title index to books table"

git -C "$WORK" branch -f healthy HEAD
git -C "$WORK" checkout --quiet -B main healthy
echo "substrate ready: $WORK (healthy = $(git -C "$WORK" rev-parse --short healthy))"
