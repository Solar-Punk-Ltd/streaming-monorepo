#!/usr/bin/env bash
# The stack version builder, run for real on one commit of this repository and
# checked on what it leaves.
#
# What it proves: manager/scripts/stack-version-build.sh fetches the commit
# from the repository on GitHub, cuts the stack's own lockfile and workspace
# file out of the root ones inside its node:24-alpine container, installs from
# them with the pnpm the stack names, builds every package of the stack, and
# leaves a staging tree the manager can publish. The commit, the folder and the
# toolchain it records are the right ones, the side folder is gone, the cut is
# byte for byte what tools/app-workspace writes from this checkout, and the
# uploader's dist, which the uploader image copies in, is built.
#
# What it does not prove: that the images build from that tree, or that a
# deployment runs on it. The integration job starts a manager on a bundled
# build. No workflow builds the stack's images, a deploy does.
#
# Usage, from apps/infra-manager, on a checkout of the commit it builds:
#   bash manager/test/docker/stack-version-build.sh <commit> <repo-url>
# <commit> is the forty character commit to build, which GitHub has to serve:
# a pushed commit, or the merge commit a pull request's run checks out.
# <repo-url> is the repository's https clone url, the only kind the builder
# takes, such as https://github.com/Solar-Punk-Ltd/streaming-monorepo.git.
# Exit 0 on a pass, 1 on a wrong answer, 2 on a harness problem. Needs docker,
# git, node and github.com, with no login while the repository is public.
set -u

readonly STACK_FOLDER="apps/hls-stream"
readonly BUILD_IMAGE="node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1"

if [ "$#" -ne 2 ] || ! [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: stack-version-build.sh <forty character commit> <repo-url>" >&2
  exit 2
fi
COMMIT="$1"
REPO_URL="$2"

MANAGER_APP="$(cd "$(dirname "$0")/../../.." && pwd)"
REPO_ROOT="$(cd "$MANAGER_APP/../.." && pwd)"
CHECKOUT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [ "$CHECKOUT" != "$COMMIT" ]; then
  echo "FAIL: this checkout is at $CHECKOUT, not $COMMIT, and the cut is compared with this checkout's" >&2
  exit 2
fi

WORK="$(mktemp -d)"
STAGING="$WORK/stack.staging"
# The container writes the install and the build as its own root, which the
# runner's user may not remove, so the staging tree goes through a container too.
cleanup() {
  if [ -e "$STAGING" ]; then
    docker run --rm -v "$WORK:/work" "$BUILD_IMAGE" rm -rf /work/stack.staging >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Building $COMMIT with manager/scripts/stack-version-build.sh"
if ! bash "$MANAGER_APP/manager/scripts/stack-version-build.sh" \
  "$WORK/stack.repo" "$STAGING" "$COMMIT" "$REPO_URL" "$STACK_FOLDER" none "${COMMIT:0:12}"; then
  echo "FAIL: the version builder did not build $COMMIT" >&2
  exit 1
fi

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# What the build records, each read the way the manager reads it.
recorded() {
  if [ -f "$STAGING/$1" ]; then cat "$STAGING/$1"; fi
}
[ "$(recorded .stack-commit)" = "$COMMIT" ] || fail ".stack-commit holds '$(recorded .stack-commit)', not $COMMIT"
[ "$(recorded .stack-folder)" = "$STACK_FOLDER" ] || fail ".stack-folder holds '$(recorded .stack-folder)', not $STACK_FOLDER"
NAMED_PNPM="$(node -p "require(process.argv[1]).packageManager" "$REPO_ROOT/$STACK_FOLDER/package.json")"
TOOLCHAIN="$BUILD_IMAGE ${NAMED_PNPM%%+*}"
[ "$(recorded .stack-toolchain)" = "$TOOLCHAIN" ] || fail ".stack-toolchain holds '$(recorded .stack-toolchain)', not '$TOOLCHAIN'"

[ ! -e "$STAGING/.workspace-root" ] || fail "the side folder .workspace-root is still in the staging tree"

# The cut the container made, against the one this checkout's tool makes.
if node "$REPO_ROOT/tools/app-workspace/cut.mjs" --root "$REPO_ROOT" --app "$STACK_FOLDER" --out "$WORK/cut"; then
  for file in pnpm-lock.yaml pnpm-workspace.yaml; do
    cmp -s "$WORK/cut/$file" "$STAGING/$file" || fail "the staging tree's $file is not the cut of this checkout's root files"
  done
else
  fail "the cut of this checkout refused, so there was nothing to compare with"
fi

[ -f "$STAGING/packages/stream-uploader/dist/index.js" ] || fail "the uploader's dist/index.js, which its image copies in, was not built"
[ -f "$STAGING/packages/client/dist/index.html" ] || fail "the client's dist/index.html was not built, so the recursive build did not run every package"

if [ "$failures" -gt 0 ]; then
  exit 1
fi
echo "PASS: built $COMMIT with $TOOLCHAIN from the cut of the root lockfile, and left what the manager publishes"
