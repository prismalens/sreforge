#!/usr/bin/env bash
# Build the code checkouts an agent may read, one git repo per alerting service, never inside sreforge:
# substrate/booklogr (booklogr-api: upstream history + metrics + index, branch `healthy`)
# and substrate/book-metadata (book-metadata: the upstream service, from stub/). Idempotent.
set -euo pipefail
STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$STACK/substrate/booklogr"
META="$STACK/substrate/book-metadata"
UPSTREAM="${UPSTREAM_REPO:-https://github.com/Mozzo1000/booklogr.git}"
# The scenario patches and the index migration's down_revision assume this upstream base (2026-07-01).
UPSTREAM_REF="${UPSTREAM_REF:-9e2d0abdc80deb4905d514d2e2e3930c91eb2f18}"
mkdir -p "$STACK/substrate"

commit() { # DIR NAME EMAIL DATE MESSAGE
  git -C "$1" add -A
  GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" \
  GIT_AUTHOR_DATE="$4" GIT_COMMITTER_DATE="$4" git -C "$1" commit --quiet -m "$5"
}

if ! git -C "$WORK" rev-parse --verify --quiet healthy >/dev/null 2>&1; then
  rm -rf "$WORK"
  git clone --quiet "$UPSTREAM" "$WORK"
  git -C "$WORK" checkout --quiet -B main "$UPSTREAM_REF"
  git -C "$WORK" remote remove origin
  NAME="$(git -C "$WORK" log -1 --format=%an)"; EMAIL="$(git -C "$WORK" log -1 --format=%ae)"

  python3 "$STACK/instrumentation/apply.py" "$WORK"
  if [ -f "$WORK/poetry.lock" ]; then
    docker run --rm -v "$WORK":/w -w /w python:3.12-slim \
      sh -c 'pip install -q "poetry==1.8.5" && poetry lock --no-update' >/dev/null 2>&1 \
      || echo "warning: poetry lock regen failed; the lockfile may be stale"
  fi
  commit "$WORK" "$NAME" "$EMAIL" "$(date -d '21 days ago 09:47' -R)" "Add Prometheus metrics (prometheus-flask-exporter, multiprocess mode)"

  mkdir -p "$WORK/migrations/versions"
  cp "$STACK"/instrumentation/schema/versions/*_add_books_owner_title_index.py "$WORK/migrations/versions/"
  commit "$WORK" "$NAME" "$EMAIL" "$(date -d '20 days ago 09:12' -R)" "Add owner/title index to books table"

  git -C "$WORK" branch -f healthy HEAD
  git -C "$WORK" checkout --quiet -B main healthy
fi

if ! git -C "$META" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  rm -rf "$META"
  mkdir -p "$META"
  cp "$STACK"/stub/* "$META/"
  git -C "$META" init --quiet -b main
  commit "$META" "Andreas Backström" "mozzo242@gmail.com" "$(date -d '60 days ago 16:20' -R)" "Book metadata service"
fi

echo "code ready: $WORK ($(git -C "$WORK" rev-parse --short healthy) healthy), $META"
