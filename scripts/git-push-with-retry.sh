#!/bin/sh
# Push the current branch from a working tree, rebasing on each failure.
# Used by every control-repo commit path; replaces inline `git push || true`
# loops that previously masked push failures.
#
# Usage: scripts/git-push-with-retry.sh [<working-dir>]
#
# Exits non-zero ONLY after MAX_RETRIES exhausted attempts. Each retry sleeps
# 2-6 jittered seconds, then `git pull --rebase` before retrying the push.

set -e

WORKDIR="${1:-.}"
MAX_RETRIES="${MAX_RETRIES:-5}"

cd "$WORKDIR"

git pull --rebase || true

RETRY_COUNT=0
until git push; do
  RETRY_COUNT=$((RETRY_COUNT+1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "::error::git push failed after $MAX_RETRIES attempts." >&2
    exit 1
  fi
  SLEEP_TIME=$(awk -v min=2 -v max=6 'BEGIN{srand(); printf "%d", min + int(rand()*(max-min+1))}')
  echo "Push failed. Retrying in ${SLEEP_TIME}s (attempt ${RETRY_COUNT}/${MAX_RETRIES})..."
  sleep "$SLEEP_TIME"
  git pull --rebase
done
