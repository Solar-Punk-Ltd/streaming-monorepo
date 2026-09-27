#!/usr/bin/env bash
# Fetch one version of the streaming stack and build it into a staging tree.
#
#   stack-version-build.sh <repo-root> <staging-dir> <ref> <repo-url> <stack-folder> <history-head> <attempt-id>
#
# <repo-root>   the clone, on the host and inside the api container alike.
#               Never deployed from: it only fetches.
# <staging-dir> where this attempt's built tree goes. The manager turns it into
#               a build of its own afterwards, so nothing here is published.
# <ref>         branch or tag to follow, or the forty character commit the
#               manager pins for the bundled version. The commit only moves
#               when this runs.
# <repo-url>    the repository the stack comes from. A constant in the
#               manager, never operator supplied.
# <stack-folder> where the stack sits in that repository: . for the whole
#               tree, or a folder such as apps/hls-stream. A constant in the
#               manager too.
# <history-head> a commit whose ancestors are the stack's own history, from
#               before it moved into <stack-folder>, or none. A commit that
#               lacks <stack-folder> is built whole when it is one of those,
#               because there the stack is the root, and refused otherwise.
# <attempt-id>  names this attempt's build container, stack-build-<attempt-id>,
#               so a manager that comes back can tell a live builder from a
#               dead one before it removes the staging tree.
#
# Writes the exported commit into <staging-dir>/.stack-commit, the folder the
# stack was taken from into <staging-dir>/.stack-folder, and the image and the
# pnpm it built with into <staging-dir>/.stack-toolchain, which is what the
# manager reads: a real build prints far more than the manager keeps of this
# stream, and the clone may have moved on by the time it looks.
#
# A commit made once the repository became one workspace keeps its lockfile at
# the root and none in <stack-folder>. The build container is then also shown
# the root's lockfile, workspace file and package.json, the stack's package.json
# under them, and the commit's own tools/app-workspace, in a side folder of the
# staging tree, and cuts the stack's own lockfile out of the root one before it
# installs anything. A stack that keeps its own lockfile builds as it always has.
#
# The packages are built in a throwaway node container rather than in the api
# image, so the api image keeps carrying no toolchain of its own. That container
# is shown the staging tree and nothing else: not the clone, and not the
# version's flat root, where the deployments keep their secrets as
# .env.<profile> files and the host keeps its base env. The build runs the
# followed branch's own install and build scripts, so a branch would be able to
# read anything it was shown.
set -euo pipefail

readonly BUILD_IMAGE="node:22-alpine"
# corepack, left to pick its own pnpm, installs the latest major, and a recent
# one stopped reading the `pnpm.overrides` block in package.json. A checkout
# that keeps its overrides there (as swarm-hls-stream does) then fails the
# frozen install with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. Pin the pnpm that
# matches the lockfile format instead. A stack that names its own in a
# `packageManager` field builds with that one, because corepack honours it over
# this, and so does what this script records.
readonly PINNED_PNPM='pnpm@9.12.0'
# Where a commit with its lockfile at the root has its side folder.
readonly WORKSPACE_ROOT_DIR=".workspace-root"

if [ "$#" -ne 7 ]; then
    echo "usage: stack-version-build.sh <repo-root> <staging-dir> <ref> <repo-url> <stack-folder> <history-head> <attempt-id>" >&2
    exit 2
fi

REPO="$1"
STAGING="$2"
REF="$3"
REPO_URL="$4"
STACK_FOLDER="$5"
HISTORY_HEAD="$6"
ATTEMPT="$7"

# Checked here as well as in the manager, because these values land in
# `git clone --branch`, `git -C`, `docker run -v` and `docker run --name`,
# where a leading dash is an option, `..` walks out of the directory, and a
# relative path is whatever the working directory happened to be.
for dir in "$REPO" "$STAGING"; do
    case "$dir" in
        /*) ;;
        *)
            echo "ERROR: directories must be absolute paths (got: $dir)" >&2
            exit 2
            ;;
    esac
    case "$dir" in
        *..*)
            echo "ERROR: directories must not contain .. (got: $dir)" >&2
            exit 2
            ;;
    esac
done
if ! [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || [[ "$REF" == -* ]] || [[ "$REF" == *..* ]]; then
    echo "ERROR: <ref> must be a branch, a tag or a commit of letters, digits, dot, underscore, slash and dash, with no leading dash and no .. (got: $REF)" >&2
    exit 2
fi
# A commit is fetched by name and checked out detached. A branch or a tag is
# what `git clone --branch` and `git fetch --tags` take, and a commit is neither.
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    REF_IS_COMMIT=yes
else
    REF_IS_COMMIT=no
fi
if ! [[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]]; then
    echo "ERROR: <repo-url> must be an https github clone url (got: $REPO_URL)" >&2
    exit 2
fi
# The folder lands in `git archive` and in `tar --strip-components`, so it is
# a relative path of plain names: no .., and no name that starts with a dot or
# a dash.
readonly FOLDER_RE='^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$'
if [ "$STACK_FOLDER" != . ] && { ! [[ "$STACK_FOLDER" =~ $FOLDER_RE ]] || [[ "$STACK_FOLDER" == *..* ]]; }; then
    echo "ERROR: <stack-folder> must be . or a relative folder of plain names (got: $STACK_FOLDER)" >&2
    exit 2
fi
if [ "$HISTORY_HEAD" != none ] && ! [[ "$HISTORY_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: <history-head> must be none or a forty character commit (got: $HISTORY_HEAD)" >&2
    exit 2
fi
if ! [[ "$ATTEMPT" =~ ^[0-9a-f]{8,32}$ ]]; then
    echo "ERROR: <attempt-id> must be 8 to 32 hex digits (got: $ATTEMPT)" >&2
    exit 2
fi
if [ -e "$STAGING" ]; then
    echo "ERROR: $STAGING exists already. An attempt never shares a staging tree." >&2
    exit 2
fi

# A failed attempt takes its staging tree with it. A successful one leaves it
# for the manager, which publishes it or removes it.
trap 'code=$?; if [ "$code" -ne 0 ]; then rm -rf "$STAGING"; fi' EXIT

# Whether a commit is one of the stack's own, from before it moved into
# <stack-folder>: an ancestor of <history-head>. A clone holds only what its
# fetches brought, so the head is fetched when it is missing. Only when that
# history cannot be read, in a shallow clone or for a head the fetch cannot
# reach, does the layout decide: no apps folder, and at the root the two files
# the manager reads a stack's contract from.
in_stack_history() {
    local commit="$1"
    [ "$HISTORY_HEAD" != none ] || return 1
    if [ "$(git -C "$REPO" rev-parse --is-shallow-repository)" = false ]; then
        if ! git -C "$REPO" cat-file -e "$HISTORY_HEAD^{commit}" 2>/dev/null; then
            echo "==> Fetching the stack's history head $HISTORY_HEAD"
            git -C "$REPO" fetch --quiet origin "$HISTORY_HEAD" ||
                echo "==> $HISTORY_HEAD could not be fetched, so the layout decides"
        fi
        if git -C "$REPO" cat-file -e "$HISTORY_HEAD^{commit}" 2>/dev/null; then
            git -C "$REPO" merge-base --is-ancestor "$commit" "$HISTORY_HEAD"
            return
        fi
    fi
    ! git -C "$REPO" cat-file -e "$commit:apps" 2>/dev/null &&
        git -C "$REPO" cat-file -e "$commit:.env.sample" 2>/dev/null &&
        git -C "$REPO" cat-file -e "$commit:deploy/scripts/_lib.sh" 2>/dev/null
}

# Git only, up to here. Nothing out of the fetched tree has run yet.
if [ -d "$REPO/.git" ]; then
    echo "==> Fetching $REF into $REPO"
    # The url is checked as an argument, so the fetch has to use that one. What
    # the clone carries is writable by anyone who can write into the versions
    # root, and a fetch honours it.
    git -C "$REPO" remote set-url origin "$REPO_URL"
    if [ "$REF_IS_COMMIT" = yes ]; then
        git -C "$REPO" fetch --prune origin "$REF"
    else
        git -C "$REPO" fetch --prune --tags origin "$REF"
    fi
    # FETCH_HEAD rather than origin/<ref>: a tag has no origin/<name>, and this
    # is the one thing a branch, a tag and a commit all leave behind.
    git -C "$REPO" checkout --detach --force FETCH_HEAD
    git -C "$REPO" reset --hard FETCH_HEAD
    ARCHIVE_REV="FETCH_HEAD"
elif [ "$REF_IS_COMMIT" = yes ]; then
    echo "==> Fetching commit $REF into a new $REPO"
    mkdir -p "$(dirname "$REPO")"
    rm -rf "$REPO"
    # An empty repository and one fetch, because `git clone --branch` takes a
    # branch or a tag name and a commit is neither. Not shallow: this clone is
    # the one every later ref of this version is fetched into, and a shallow
    # clone stays shallow for all of them.
    git init -q "$REPO"
    git -C "$REPO" remote add origin "$REPO_URL"
    git -C "$REPO" fetch origin "$REF"
    git -C "$REPO" checkout --detach --force FETCH_HEAD
    ARCHIVE_REV="FETCH_HEAD"
else
    echo "==> Cloning $REF into $REPO"
    mkdir -p "$(dirname "$REPO")"
    rm -rf "$REPO"
    git clone --branch "$REF" --single-branch "$REPO_URL" "$REPO"
    ARCHIVE_REV="HEAD"
fi

# ^{commit}: fetching an annotated tag leaves FETCH_HEAD on the tag object,
# and what a version records is the commit that tag points at.
COMMIT="$(git -C "$REPO" rev-parse "$ARCHIVE_REV^{commit}")"
echo "STACK_COMMIT=$COMMIT"
# The commit itself from here on, because fetching the history head below
# moves FETCH_HEAD, even when that fetch fails.
ARCHIVE_REV="$COMMIT"

# Which folder of this commit holds the stack. A commit made since the stack
# moved has <stack-folder>. One of the stack's own history is the stack at the
# root. Anything else holds no stack, and nothing of it runs.
EXPORT_FOLDER="."
if [ "$STACK_FOLDER" != . ]; then
    if [ "$(git -C "$REPO" cat-file -t "$COMMIT:$STACK_FOLDER" 2>/dev/null)" = tree ]; then
        EXPORT_FOLDER="$STACK_FOLDER"
    elif ! in_stack_history "$COMMIT"; then
        echo "ERROR: $COMMIT has no $STACK_FOLDER and is not a commit of the stack's own history, so it holds no stack to build" >&2
        exit 2
    fi
fi
echo "STACK_FOLDER=$EXPORT_FOLDER"

echo "==> Exporting $COMMIT:$EXPORT_FOLDER into $STAGING"
mkdir -p "$STAGING"
if [ "$EXPORT_FOLDER" = . ]; then
    git -C "$REPO" archive "$ARCHIVE_REV" | tar -x -C "$STAGING"
else
    # The commit narrowed to the folder, rather than the folder's own tree,
    # because git dates the files with the commit's time only when it archives
    # a commit. That keeps the file times a whole-tree export has. The folder's
    # path is then stripped, one component for each name in it.
    IFS=/ read -r -a FOLDER_NAMES <<< "$EXPORT_FOLDER"
    git -C "$REPO" archive "$ARCHIVE_REV" -- "$EXPORT_FOLDER" |
        tar -x --strip-components="${#FOLDER_NAMES[@]}" -C "$STAGING"
fi

# A stack with no lockfile of its own, in a commit with one at the root, is cut
# out of the root one inside the container, by the commit's own tool, before the
# install. Its inputs go into a side folder of the staging tree, the one tree
# the container is shown. The tool refuses to write into the folder it reads
# from, so the cut lands in the stack's own place, as the lockfile used to.
CUT_COMMAND=""
if [ "$EXPORT_FOLDER" != . ] && [ ! -e "$STAGING/pnpm-lock.yaml" ] &&
    git -C "$REPO" cat-file -e "$COMMIT:pnpm-lock.yaml" 2>/dev/null; then
    if ! git -C "$REPO" cat-file -e "$COMMIT:tools/app-workspace/cut.mjs" 2>/dev/null; then
        echo "ERROR: $COMMIT keeps its lockfile at the root and holds no tools/app-workspace to cut the stack's own out of it" >&2
        exit 2
    fi
    if [ -e "$STAGING/$WORKSPACE_ROOT_DIR" ]; then
        echo "ERROR: $COMMIT's $EXPORT_FOLDER holds a $WORKSPACE_ROOT_DIR of its own, where the build puts the root's files" >&2
        exit 2
    fi
    echo "==> Exporting the root's lockfile, workspace file, package.json and tools/app-workspace into $STAGING/$WORKSPACE_ROOT_DIR"
    mkdir "$STAGING/$WORKSPACE_ROOT_DIR"
    git -C "$REPO" archive "$ARCHIVE_REV" -- package.json pnpm-lock.yaml pnpm-workspace.yaml tools/app-workspace "$EXPORT_FOLDER/package.json" |
        tar -x -C "$STAGING/$WORKSPACE_ROOT_DIR"
    CUT_COMMAND="node $WORKSPACE_ROOT_DIR/tools/app-workspace/cut.mjs --root $WORKSPACE_ROOT_DIR --app $EXPORT_FOLDER --out . && "
fi

# The pnpm the build runs, worked out as corepack works it out and before
# anything of the commit runs: the stack's own packageManager when it names
# one, the pin otherwise. That pnpm, with the image, is what the build records.
PACKAGE_MANAGER="$(node -e 'const manager = require(process.argv[1]).packageManager; if (typeof manager === "string") process.stdout.write(manager)' "$STAGING/package.json")"
if [ -z "$PACKAGE_MANAGER" ]; then
    BUILD_PNPM="$PINNED_PNPM"
elif [[ "$PACKAGE_MANAGER" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+(\+sha[0-9]+\.[0-9a-f]+)?$ ]]; then
    BUILD_PNPM="$PACKAGE_MANAGER"
else
    echo "ERROR: $COMMIT's stack names $PACKAGE_MANAGER in its package.json's packageManager, which is no pnpm this script builds with" >&2
    exit 2
fi
readonly BUILD_TOOLCHAIN="$BUILD_IMAGE ${BUILD_PNPM%%+*}"
readonly BUILD_COMMAND="${CUT_COMMAND}corepack enable && corepack prepare ${BUILD_PNPM} --activate && pnpm install --frozen-lockfile && pnpm -r build"
echo "STACK_TOOLCHAIN=$BUILD_TOOLCHAIN"

# No -e and no --env-file: the container gets the staging tree, a cpu and memory
# ceiling, a process ceiling, a name the manager can ask Docker about, and
# nothing else of this host.
echo "==> Installing and building the packages in $BUILD_IMAGE as stack-build-$ATTEMPT"
docker run --rm \
    --name "stack-build-$ATTEMPT" \
    --memory 4g \
    --cpus 2 \
    --pids-limit 512 \
    -v "$STAGING:$STAGING" \
    -w "$STAGING" \
    "$BUILD_IMAGE" sh -c "$BUILD_COMMAND"

# The side folder goes before the manager sees the tree, whatever the build did
# to it. rm -rf on a link the build left removes the link, never what it points at.
if [ -n "$CUT_COMMAND" ]; then
    rm -rf "$STAGING/$WORKSPACE_ROOT_DIR"
fi

# What this script exported and built with, written only now that the ref's own
# scripts have run over the tree, so none of them can change it. Whatever they
# left at these names goes first, because a link left there would carry the
# write out of the tree, and the container has exited, so nothing can put one back.
rm -rf "$STAGING/.stack-commit" "$STAGING/.stack-folder" "$STAGING/.stack-toolchain"
printf '%s\n' "$COMMIT" > "$STAGING/.stack-commit"
printf '%s\n' "$EXPORT_FOLDER" > "$STAGING/.stack-folder"
printf '%s\n' "$BUILD_TOOLCHAIN" > "$STAGING/.stack-toolchain"

echo "==> Built $COMMIT in $STAGING"
