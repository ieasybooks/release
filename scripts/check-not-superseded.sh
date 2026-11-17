#!/usr/bin/env bash
# Stops a release that a newer release of the same component has superseded:
# re-running an older release's failed job after a newer one shipped, or an
# older release whose checks finished later, would otherwise put the older
# version back on mofied.com or pull the newer one out of App Store review.
# Compares TAG with the repository's version tags of its component (v* for
# the apps, web-v* for the web). Going back to an older version is a rollback
# (docs/releasing.md). Uses gh, with GH_TOKEN in the workflows.
#
#   ieasybooks-release not-superseded TAG
set -euo pipefail

usage="usage: ieasybooks-release not-superseded TAG"
tag=${1:?$usage}
repo=${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to the repository, such as ieasybooks/mofied}
version='([0-9]+)\.([0-9]+)\.([0-9]+)'

if ! [[ $tag =~ ^(.*v)$version$ ]]; then
  echo "::error::$tag isn't a version tag, such as v0.1.3 or web-v0.1.3."
  exit 1
fi
prefix=${BASH_REMATCH[1]}
newest=$tag
newest_version=("${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}")

# Whether version $1.$2.$3 is past $4.$5.$6.
later() {
  if ((10#$1 != 10#$4)); then
    ((10#$1 > 10#$4))
  elif ((10#$2 != 10#$5)); then
    ((10#$2 > 10#$5))
  else
    ((10#$3 > 10#$6))
  fi
}

# Every tag starting with the prefix; those that aren't this component's
# version tags (v0-dry-run, or vault-… for the apps' v) don't count.
refs=$(gh api "repos/$repo/git/matching-refs/tags/$prefix" --paginate --jq '.[].ref')
while read -r ref; do
  name=${ref#refs/tags/}
  [[ $name =~ ^"$prefix"$version$ ]] || continue
  if later "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${newest_version[@]}"; then
    newest=$name
    newest_version=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
  fi
done <<<"$refs"

if [ "$newest" != "$tag" ]; then
  echo "::error::$newest is newer than $tag, so releasing $tag would replace it. Re-run $newest's release if it failed, or release a newer version; to go back to $tag on purpose, roll back (docs/releasing.md)."
  exit 1
fi
echo "No release is newer than $tag."
