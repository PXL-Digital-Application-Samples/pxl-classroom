#!/bin/sh
# Fetch the branch's head into FETCH_HEAD, retried (review 2026-10-16, R7-26).
#
# The finalize asks the branch, right before it commits, whether the
# assignment was deleted or its deadline changed while it ran. One fetch that
# did not answer failed the step, and the lock record, the observations and the
# preservation it was about to commit went with it. A fetch is a read, so a
# retry can only help: a network or GitHub error, three tries, each under a
# minute, a growing pause with jitter between them, every try said. Giving up
# is not a failure here; the caller decides what not knowing means.
#
# Usage: scripts/git-fetch-with-retry.sh <working-dir>
# Exits 0 when FETCH_HEAD is the branch's head, 1 when no try answered.

WORKDIR="${1:-.}"
TRIES="${FETCH_TRIES:-3}"

i=1
while [ "$i" -le "$TRIES" ]; do
  if timeout 60 git -C "$WORKDIR" fetch -q origin HEAD; then
    exit 0
  fi
  echo "fetch try $i of $TRIES did not answer"
  if [ "$i" -lt "$TRIES" ]; then
    # 5s, 10s, ... plus up to 4s, so two legs of one organization do not retry in step.
    sleep $(( i * 5 + $(od -An -N1 -tu1 /dev/urandom) % 5 ))
  fi
  i=$((i + 1))
done
echo "fetch gave up after $TRIES tries"
exit 1
