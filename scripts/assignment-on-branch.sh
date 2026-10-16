#!/bin/sh
# Whether an assignment still exists on the control repository's branch, asked
# of GitHub rather than of the job's checkout (review 2026-10-16, R7-17).
#
# The finalize commits what it did for an assignment minutes after it read it.
# One deleted in between was put back by that commit: its lock record, its
# observations and its directories, for an assignment nobody has any more. Two
# commit steps ask this now - the lock record's and the finalize's - so it is
# one script rather than two spellings of three `cat-file`s.
#
# Usage: scripts/assignment-on-branch.sh <working-dir> <assignment-id>
# Exits 0 when it exists on the branch, 1 when it does not, 2 when the branch
# could not be fetched (git-fetch-with-retry.sh gave up): the caller decides
# what not knowing means.

DIR="${1:?working dir}"
ID="${2:?assignment id}"

"$(dirname "$0")/git-fetch-with-retry.sh" "$DIR" || exit 2
for ext in yml yaml json; do
  if git -C "$DIR" cat-file -e "FETCH_HEAD:assignments/${ID}.${ext}" 2>/dev/null; then
    exit 0
  fi
done
exit 1
