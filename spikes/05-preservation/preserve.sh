#!/usr/bin/env bash
# PXL Classroom — Spike 5: preserve a selected SHA from a student repo into an
# instructor-controlled archive repo, verify the hash, and prove independence
# from the source (survives a force-push / history rewrite).
#
# Production: run in a trusted workflow authenticated as the GitHub App
# installation token. This script uses `gh auth setup-git` so git over HTTPS
# uses the gh token — swap in the App token in CI.
#
# Usage: SRC=org/repo ARC=org/archive REF=preserved/<assignment>-<student> ./preserve.sh
set -euo pipefail

SRC="${SRC:?set SRC=org/repo}"
ARC="${ARC:?set ARC=org/archive}"
PRES_REF="refs/heads/${REF:?set REF=preserved/<id>}"
WORK="$(mktemp -d)"

gh auth setup-git
gh repo view "$ARC" >/dev/null 2>&1 || gh repo create "$ARC" --private -d "PXL Classroom preservation archive"

git clone -q "https://github.com/$SRC" "$WORK/src"
cd "$WORK/src"
SHA="$(git rev-parse HEAD)"
SRC_ID="$(gh api "/repos/$SRC" --jq .id)"
echo "source_repo_id=$SRC_ID source_ref=refs/heads/$(git rev-parse --abbrev-ref HEAD) preserve_sha=$SHA"

# Preserve: push the commit (and its reachable history) to the archive.
git push -q "https://github.com/$ARC" "$SHA:$PRES_REF"

# Verify the preserved hash.
ARC_SHA="$(git ls-remote "https://github.com/$ARC" "$PRES_REF" | awk '{print $1}')"
[ "$ARC_SHA" = "$SHA" ] && echo "verify_match=yes" || { echo "verify_match=NO"; exit 1; }

# Confirm the object is independently fetchable from the archive.
git clone -q "https://github.com/$ARC" "$WORK/arc"
git -C "$WORK/arc" cat-file -e "$SHA" && echo "object_fetchable=yes"

echo "preserved $SHA from $SRC ($SRC_ID) into $ARC:$PRES_REF"
