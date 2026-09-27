#!/usr/bin/env bash
# Where the stack's lockfile comes from in a checkout of the one workspace, for deploy.sh and
# bench-on-host.sh alike. Sourced, never run.
#
# An image build and an install on a host read pnpm-lock.yaml and pnpm-workspace.yaml at the root of
# the stack's folder. Every build tree the manager makes holds them there, and so does a checkout from
# before the repository became one workspace. A checkout of the one workspace holds them only at its
# root, and tools/app-workspace cuts the stack's own pair out of the root's. The pair is only ever
# written into a folder outside the checkout: a second pnpm-workspace.yaml in the stack's folder
# would make it a workspace of its own.

# Prints the folder pnpm would take as the workspace root above the stack folder given, when that
# folder holds the root lockfile, and nothing otherwise.
one_workspace_root() {
  local dir
  dir="$(dirname "$1")"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/pnpm-workspace.yaml" ]; then
      if [ -f "$dir/pnpm-lock.yaml" ]; then
        printf '%s\n' "$dir"
      fi
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

# Cuts the stack's pnpm-lock.yaml and pnpm-workspace.yaml out of the workspace root's into a folder:
# cut_stack_pair <workspace root> <stack folder from the root> <out folder>
cut_stack_pair() {
  node "$1/tools/app-workspace/cut.mjs" --root "$1" --app "$2" --out "$3"
}
