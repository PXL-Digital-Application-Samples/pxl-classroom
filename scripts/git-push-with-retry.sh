#!/bin/sh
# Push the current branch from a working tree, rebasing on each failure.
# Used by every control-repo commit path; replaces inline `git push || true`
# loops that previously masked push failures.
#
# Usage: scripts/git-push-with-retry.sh [<working-dir>]
#
# Exits non-zero after MAX_RETRIES exhausted attempts, or immediately on a
# rebase CONFLICT, which retrying cannot fix.
#
# A CONFLICT IS NOT A RETRYABLE PUSH FAILURE, and this script used to treat it
# as one by accident. `set -e` plus an unguarded `git pull --rebase` meant a
# conflict killed the script from INSIDE the rebase: the working tree was left
# mid-rebase, the log showed git's "resolve all conflicts manually" hint rather
# than anything about this system, and the caller's work was lost with no
# statement of what had collided. Measured on a live drill, 2026-09-08, where
# two finalize legs in one organization both rewrote reports/dashboard.json.
# The collision itself is fixed where it belongs - one writer per document - and
# this is the part that makes the next one legible instead of cryptic.
#
# Only UNMERGED PATHS mean a conflict. A pull that fails for any other reason -
# no upstream yet, a transient network error - is left alone exactly as the
# original `|| true` left it, for the push and its retries to report.

set -e

WORKDIR="${1:-.}"
MAX_RETRIES="${MAX_RETRIES:-5}"

cd "$WORKDIR"

pull_rebase() {
  if git pull --rebase; then
    return 0
  fi
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
  if [ -z "$CONFLICTS" ]; then
    return 0
  fi
  # Reported before the abort, because `git rebase --abort` is what clears the
  # unmerged paths that name the collision.
  git rebase --abort 2>/dev/null || true
  echo "::error::Rebase onto the remote conflicted on: ${CONFLICTS}- another writer changed the same file, and this commit was NOT pushed. Retrying cannot resolve it; the two writers have to be reconciled." >&2
  exit 1
}

pull_rebase

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
  pull_rebase
done
