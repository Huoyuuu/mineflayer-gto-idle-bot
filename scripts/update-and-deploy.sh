#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

branch="${DEPLOY_BRANCH:-server-live}"
current_branch="$(git symbolic-ref --quiet --short HEAD)"
if [[ "$current_branch" != "$branch" ]]; then
  echo "[update] refusing to deploy branch $current_branch; expected $branch" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[update] refusing to overwrite tracked local changes" >&2
  exit 1
fi

remote_ref="refs/remotes/origin/$branch"
git fetch --quiet --no-tags origin "refs/heads/$branch:$remote_ref"

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "$remote_ref")"
if [[ "$local_sha" == "$remote_sha" ]]; then
  echo "[update] already current at ${local_sha:0:7}"
  exit 0
fi

if ! git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
  echo "[update] refusing non-fast-forward update ${local_sha:0:7} -> ${remote_sha:0:7}" >&2
  exit 1
fi

echo "[update] deploying ${local_sha:0:7} -> ${remote_sha:0:7}"
# The timer calls deploy explicitly so a failed deployment makes the unit fail.
# Manual git pull still uses .githooks/post-merge.
git -c core.hooksPath=/dev/null merge --ff-only "$remote_ref"
# Static files are read from disk per request, so frontend/docs-only updates need no restart.
changed="$(git diff --name-only "$local_sha" "$remote_sha")"
if ! grep -qvE '^(public/|docs/|test/)|\.md$|^\.gitignore$' <<<"$changed"; then
  echo "[update] hot update ${remote_sha:0:7}: bot service not restarted"
  exit 0
fi
exec "$root_dir/scripts/deploy.sh"
