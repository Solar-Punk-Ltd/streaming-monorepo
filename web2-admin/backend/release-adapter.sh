#!/bin/bash
set -euo pipefail

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 1
}

phase="${1:-}"

case "$phase" in
  preflight|build|verify)
    if [ "$#" -ne 5 ] || [ "$2" != "--plan" ] || [ "$4" != "--output" ]; then
      refuse "admin release adapter arguments are invalid"
    fi
    ;;
  transition)
    if [ "$#" -ne 3 ] || [ "$2" != "--plan" ]; then
      refuse "admin release adapter arguments are invalid"
    fi
    ;;
  *) refuse "admin release adapter phase is invalid" ;;
esac

plan="$3"
output="${5:-}"

node --input-type=module - "$plan" "$phase" <<'NODE'
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [planPath, expectedPhase] = process.argv.slice(2);
let value;
try {
  const stat = lstatSync(planPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) {
    throw new Error('invalid file');
  }
  value = JSON.parse(readFileSync(planPath, 'utf8'));
} catch {
  process.stderr.write('REFUSED: admin release plan is invalid\n');
  process.exit(1);
}
const record = value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = record ? Object.keys(value).sort() : [];
const exactKeys = [
  'activeArtifactPath',
  'arguments',
  'candidateRoot',
  'images',
  'phase',
  'schemaVersion',
  'slot',
  'temporaryProject',
  'treeDigest',
];
const exact = keys.length === exactKeys.length && exactKeys.every((key, index) => keys[index] === key);
const slot = record && value.slot !== null && typeof value.slot === 'object' && !Array.isArray(value.slot)
  ? value.slot
  : null;
const args = record && value.arguments !== null && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
  ? value.arguments
  : null;
if (
  !record || !exact || value.schemaVersion !== 1 || value.phase !== expectedPhase ||
  typeof value.candidateRoot !== 'string' || !isAbsolute(value.candidateRoot) ||
  typeof value.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.treeDigest) ||
  value.temporaryProject !== `release-${value.treeDigest.slice(0, 20)}` ||
  slot?.role !== 'admin' || slot?.id !== 'default' || Object.keys(slot).length !== 2 ||
  args === null || Object.keys(args).length !== 0 || !Array.isArray(value.images)
) {
  process.stderr.write('REFUSED: admin release plan is invalid\n');
  process.exit(1);
}
NODE

if [ "$phase" = "transition" ] || [ "$phase" = "verify" ]; then
  refuse "admin production release coordinator is not configured"
fi

if [ "$phase" = "preflight" ]; then
  umask 077
  printf '%s\n' '{"schemaVersion":1}' > "$output"
  exit 0
fi

candidate_root="$(node -e "const p=require(process.argv[1]);process.stdout.write(p.candidateRoot)" "$plan")"
tree_digest="$(node -e "const p=require(process.argv[1]);process.stdout.write(p.treeDigest)" "$plan")"
tag_suffix="${tree_digest:0:20}"
api_tag="streaming-admin-api-release-${tag_suffix}"
web_tag="streaming-admin-web-release-${tag_suffix}"

docker build --tag "$api_tag" --file "$candidate_root/web2-admin/backend/Dockerfile" "$candidate_root"
docker build --tag "$web_tag" --file "$candidate_root/web2-admin/frontend/Dockerfile" "$candidate_root"
api_id="$(docker image inspect --format '{{.Id}}' "$api_tag")"
web_id="$(docker image inspect --format '{{.Id}}' "$web_tag")"

umask 077
node --input-type=module - "$output" "$api_id" "$web_id" <<'NODE'
import { openSync, closeSync, fsyncSync, renameSync, writeFileSync } from 'node:fs';

const [output, apiId, webId] = process.argv.slice(2);
for (const imageId of [apiId, webId]) {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    process.stderr.write('REFUSED: built admin image id is invalid\n');
    process.exit(1);
  }
}
const body = `${JSON.stringify({
  schemaVersion: 1,
  images: [
    { service: 'admin-api', imageId: apiId },
    { service: 'admin-web', imageId: webId },
  ],
})}\n`;
const temporary = `${output}.tmp.${process.pid}`;
writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
const descriptor = openSync(temporary, 'r');
try {
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
renameSync(temporary, output);
NODE
