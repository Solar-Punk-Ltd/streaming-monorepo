#!/usr/bin/env bash
# The real SRS parser on eight files at once, each differing in one
# directive.
#
# What it proves: the manager's own config check, with its own command runner
# and the deployment's own image, answers eight concurrent questions
# separately. Four files that differ in one directive value are accepted, four
# that break a different directive each are refused, every refusal names the
# directive of its own file and none of the other three, and the scratch
# directory is empty when the eight are done. A check that read another
# check's copy would refuse with a directive the operator cannot find in the
# file in front of them, which reads exactly like a real refusal.
#
# What it does not prove: that any of these files would run. Nothing is
# started here, only parsed, and the engine that parses a file is not the
# engine that has to stay up on it. That is the engine startup failure test.
#
# Usage, from the repository root, with the stack submodule checked out:
#   bash manager/test/docker/srs-check-isolation.sh
# Exit 0 on pass, 1 on a wrong answer, 2 on a harness problem. Needs docker and
# the image below. No funds, no host, no network beyond the image: every check
# container runs with --network none.
#
# Evidence, 2026-10-20, this laptop, arm64, Docker 29.9.1, on the image below,
# which is built for amd64 and ran under emulation: PASS. Eight checks at once,
# four accepted, four refused, each refusal naming only its own directive,
# scratch directory empty. The four refusal strings are the ones
# test/unit/srsCheckIsolation.test.ts records.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STACK="$(cd "$ROOT/../hls-stream" && pwd)"
# The image and digest the stack's compose files pin for its srs service, so
# the parser here is the parser a deployment gets. test/unit/srsImagePin.test.ts
# fails when the two differ.
IMAGE="${SRS_CHECK_IMAGE:-ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.4@sha256:090f7b4e9017629b6837866e314e5576f7a1becf4cf3bfd85f393ada0e5f5d5a}"

# An override is for pinning a different build, never for going back to a tag.
# A tag moves, and the whole claim of this harness is that the parser it asks
# is the one a deployment gets, which only a digest can hold still.
case "$IMAGE" in
  *@sha256:*) ;;
  *)
    echo "FAIL: SRS_CHECK_IMAGE is $IMAGE, which is not pinned. Name it with @sha256:<digest>." >&2
    exit 2
    ;;
esac

if [ ! -f "$STACK/engines/srs/srs.conf.template" ] || [ ! -f "$STACK/engines/srs/entrypoint.sh" ]; then
  echo "FAIL: there is no stack at $STACK, which is the monorepo's apps/hls-stream" >&2
  exit 2
fi

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null || {
  echo "FAIL: could not get $IMAGE" >&2
  exit 2
}

# The scratch root is made and removed here rather than by the driver, so a
# run stopped by a signal leaves nothing behind either. The containers remove
# themselves daemon side, the directory has nobody but this.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
"$ROOT/manager/node_modules/.bin/tsx" --conditions=development \
  "$ROOT/manager/test/docker/srsCheckIsolation.ts" "$STACK" "$IMAGE" "$SCRATCH"
