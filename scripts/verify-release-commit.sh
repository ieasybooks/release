#!/usr/bin/env bash
# Checks a release before it ships: that the tag still points at the commit
# being released, through any annotated tag, and with --checked that main's
# checks passed on that commit (the "Checks" status release-please.yml posts
# after them). Uses gh, with GH_TOKEN in the workflows.
#
#   ieasybooks-release verify-commit TAG SHA [--checked]
set -euo pipefail

usage="usage: ieasybooks-release verify-commit TAG SHA [--checked]"
tag=${1:?$usage}
sha=${2:?$usage}
checked=${3:-}
repo=${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to the repository, such as ieasybooks/mofied}

object=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha' 2>/dev/null) || {
  echo "::error::There's no tag $tag."
  exit 1
}
read -r type target <<<"$object"
# An annotated tag points at a tag object, which can point at another.
for _ in 1 2 3 4 5; do
  [ "$type" = tag ] || break
  object=$(gh api "repos/$repo/git/tags/$target" --jq '.object.type + " " + .object.sha')
  read -r type target <<<"$object"
done
if [ "$type" != commit ] || [ "$target" != "$sha" ]; then
  echo "::error::The tag $tag points at $type $target, not at $sha, the commit being released."
  exit 1
fi
echo "$tag points at $sha."

if [ "$checked" = --checked ]; then
  state=$(gh api "repos/$repo/commits/$sha/status" --jq '[.statuses[] | select(.context == "Checks")][0].state // "missing"')
  if [ "$state" != success ]; then
    echo "::error::Main's checks haven't passed on $sha (its Checks status is $state). Tag a commit whose checks passed on main."
    exit 1
  fi
  echo "Main's checks passed on $sha."
fi
