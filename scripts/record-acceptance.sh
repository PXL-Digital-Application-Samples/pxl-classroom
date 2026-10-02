#!/usr/bin/env bash
# Write what provisioning produced into the control repository, and push it.
#
# Used by acceptance-handler.yml and retry-acceptance.yml alike, so the two
# cannot drift: this block was copied between them, comments and all.
#
# RE-APPLIED, NEVER REBASED. Nothing serialises acceptances any more
# (lib/acceptance-reservation.mjs), so two members of one team can finish at
# the same moment, and both write the team's manifest - one adds the repository
# to it, the other was added to it by its own decision a second earlier. A
# rebase of one onto the other conflicts on that file, and git-push-with-retry.sh
# correctly refuses to guess; the record was then lost. Everything this writes
# is a function of the latest control repository plus what provisioning said,
# so on a refused push it resets to the remote and writes it all again.
#
# AND ONLY WHILE THIS RUN STILL OWNS THE DECISION. The acceptance record names
# the run that decided it (`decided_by_run_id`). If another attempt by the same
# student decided since - they switched team while this one was provisioning -
# its run writes the repository record, and this one stands aside rather than
# pointing the student back at the repository they left.
#
# Env: DATA_DIR (default control), ASSIGNMENT_ID, LOGIN, TEAM_SLUG, OUTCOME,
# ORG, TARGET_REPO, REPO_ID, REPO_URL, BASELINE_SHA, STUDENT_PERMISSION,
# RUN_URL, COMMIT_LABEL ("Provision" / "Retry-provision"), GITHUB_RUN_ID.

set -euo pipefail

DIR="${DATA_DIR:-control}"
MAX_RETRIES="${MAX_RETRIES:-15}"
ACCEPT_FILE="acceptances/${ASSIGNMENT_ID}/${LOGIN}.json"
BRANCH=$(git -C "$DIR" rev-parse --abbrev-ref HEAD)

# True unless the record names a DIFFERENT run. A record from before the field,
# an unreadable one, or no record at all is treated as before this existed.
still_ours() {
  [ -n "${GITHUB_RUN_ID:-}" ] || return 0
  [ -f "$DIR/$ACCEPT_FILE" ] || return 0
  local decided
  decided=$(node scripts/read-json-field.mjs "$DIR/$ACCEPT_FILE" decided_by_run_id 2>/dev/null) || return 0
  [ -z "$decided" ] || [ "$decided" = "$GITHUB_RUN_ID" ]
}

# Writes and commits. Returns 0 having committed, 1 with nothing to commit, 2
# on an error. EVERY command carries `|| return 2`: `set -e` is suspended for
# the whole body of a function called as a condition, so without them a failed
# write would be committed around and reported as recorded.
apply() {
  # `git add <dir>/` is FATAL when the directory does not exist - exit 128 and
  # nothing staged, not even the paths that did match - so each add has its
  # mkdir right before it. A control repository that never ran a group
  # assignment has no teams/ (git cannot store an empty directory).
  if [ "$OUTCOME" = "created" ] || [ "$OUTCOME" = "reused" ]; then
    node scripts/write-repository-record.mjs \
      --assignment-id "$ASSIGNMENT_ID" \
      --login "$LOGIN" \
      --org "$ORG" \
      --target-repo "$TARGET_REPO" \
      --team-slug "$TEAM_SLUG" \
      --repo-id "$REPO_ID" \
      --repo-url "$REPO_URL" \
      --baseline-sha "$BASELINE_SHA" \
      --student-permission "$STUDENT_PERMISSION" \
      --run-url "$RUN_URL" \
      --data-dir "$DIR" || return 2
    mkdir -p "$DIR/repositories" || return 2
    git -C "$DIR" add "repositories/" || return 2
  elif [ -n "$TEAM_SLUG" ] && [ -n "$REPO_ID" ]; then
    # Failed after the team repository existed: record it on the team only,
    # or accept.mjs refuses the next teammate over their own team's repository.
    node scripts/write-repository-record.mjs --team-only \
      --assignment-id "$ASSIGNMENT_ID" --org "$ORG" \
      --target-repo "$TARGET_REPO" --team-slug "$TEAM_SLUG" \
      --repo-id "$REPO_ID" --repo-url "$REPO_URL" --data-dir "$DIR" || return 2
  fi
  mkdir -p "$DIR/teams" || return 2
  git -C "$DIR" add "teams/" || return 2

  if [ -f "$DIR/$ACCEPT_FILE" ]; then
    local status=failed
    if [ "$OUTCOME" = "created" ] || [ "$OUTCOME" = "reused" ]; then status=provisioned; fi
    node scripts/update-json-field.mjs --schema acceptance "$DIR/$ACCEPT_FILE" "status" "$status" || return 2
    mkdir -p "$DIR/acceptances" || return 2
    git -C "$DIR" add "acceptances/" || return 2
  fi

  if git -C "$DIR" diff --cached --quiet; then
    return 1
  fi
  git -C "$DIR" -c "user.name=pxl-classroom[bot]" \
    -c "user.email=pxl-classroom[bot]@users.noreply.github.com" \
    commit -q -m "${COMMIT_LABEL:-Provision} ${LOGIN} for ${ASSIGNMENT_ID} (${OUTCOME})" || return 2
}

attempt=0
while :; do
  attempt=$((attempt + 1))
  if ! still_ours; then
    echo "::notice::A newer attempt by ${LOGIN} for ${ASSIGNMENT_ID} was decided while this one was provisioning; it owns the record, so this run writes nothing."
    exit 0
  fi
  rc=0
  apply || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "Nothing to record."
    exit 0
  fi
  if [ "$rc" -ne 0 ]; then
    echo "::error::Writing the record for ${LOGIN} on ${ASSIGNMENT_ID} failed (see above); nothing was pushed." >&2
    exit 1
  fi
  if git -C "$DIR" push -q origin "HEAD:refs/heads/${BRANCH}"; then
    exit 0
  fi
  if [ "$attempt" -ge "$MAX_RETRIES" ]; then
    echo "::error::The record for ${LOGIN} on ${ASSIGNMENT_ID} could not be pushed after ${MAX_RETRIES} attempts." >&2
    exit 1
  fi
  SLEEP_TIME=$(awk -v min=2 -v max=6 'BEGIN{srand(); printf "%d", min + int(rand()*(max-min+1))}')
  echo "Push refused (another run pushed first). Writing the record again on the latest state in ${SLEEP_TIME}s (attempt ${attempt}/${MAX_RETRIES})..."
  sleep "$SLEEP_TIME"
  git -C "$DIR" fetch -q origin "$BRANCH" || continue
  # The push may have landed with its answer lost on the way back. Writing the
  # record again on top would be a second, identical commit at best.
  if git -C "$DIR" merge-base --is-ancestor HEAD FETCH_HEAD; then
    echo "The push reported a failure, but the record is on the branch."
    exit 0
  fi
  git -C "$DIR" reset -q --hard FETCH_HEAD
  git -C "$DIR" clean -fdq -- repositories teams acceptances
done
