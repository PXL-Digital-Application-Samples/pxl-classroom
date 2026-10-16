#!/usr/bin/env bash
# Work owed keeps the nightly on (review 2026-10-16, R7-13).
#
# The nightly switches itself off when nothing is active, and only a publish
# switched it on again - so a Retry after every deadline (a repository nothing
# locks), or a deadline moved later without publishing, was owed a nightly
# that never ran. This asks the queue's own count (scripts/find-finalizable.mjs
# `active`, the number the nightly keeps itself on by) and switches it on when
# that is above zero. Idempotent: enabling an enabled workflow is a no-op.
#
#   scripts/keep-nightly-on.sh <control-checkout> <org>
#
# Env: GITHUB_TOKEN (actions: write on the hub), GITHUB_REPOSITORY,
# GITHUB_API_VERSION. Called by regenerate-dashboard.yml after a rebuild and by
# deadline-sentinel.yml's 4-hourly arming, both under continue-on-error.
set -euo pipefail

control="$1"
org="$2"

# Beside this script, whatever the working directory; the count lands in it.
node "$(dirname "$0")/find-finalizable.mjs" "$control" "$org" > /dev/null
active=$(jq -r '.active // 0' "active-${org}.json")
if [ "$active" -gt 0 ]; then
  if ! gh api -H "X-GitHub-Api-Version: ${GITHUB_API_VERSION}" --method PUT \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/daily-activity.yml/enable" > /dev/null; then
    echo "::warning::Could not switch the nightly on, and ${active} assignment(s) in ${org} owe it work."
  fi
fi
