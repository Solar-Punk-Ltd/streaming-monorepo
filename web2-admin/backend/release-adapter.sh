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
candidate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
backend_root="${candidate_root}/web2-admin/backend"
compose_file="${backend_root}/release-compose.yml"
release_env="${HOME}/.config/web2-admin/release.env"

plan_value() {
  node --input-type=module - "$plan" "$phase" "$1" <<'NODE'
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [planPath, expectedPhase, key] = process.argv.slice(2);
let value;
try {
  const stat = lstatSync(planPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) throw new Error('invalid file');
  value = JSON.parse(readFileSync(planPath, 'utf8'));
} catch {
  process.stderr.write('REFUSED: admin release plan is invalid\n');
  process.exit(1);
}
const record = value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = ['activeArtifactPath', 'arguments', 'candidateRoot', 'images', 'phase', 'schemaVersion', 'slot', 'temporaryProject', 'treeDigest'];
const slot = record && value.slot !== null && typeof value.slot === 'object' && !Array.isArray(value.slot) ? value.slot : null;
const args = record && value.arguments !== null && typeof value.arguments === 'object' && !Array.isArray(value.arguments) ? value.arguments : null;
const target = args?.target !== null && typeof args?.target === 'object' && !Array.isArray(args.target) ? args.target : null;
const fixtureNetwork = args?.fixtureNetwork !== null && typeof args?.fixtureNetwork === 'object' && !Array.isArray(args.fixtureNetwork)
  ? args.fixtureNetwork
  : null;
const argumentKeys = args === null ? [] : Object.keys(args).sort();
const argumentsAreExact = argumentKeys.join(',') === 'target' || argumentKeys.join(',') === 'fixtureNetwork,target';
const fixtureNetworkKeys = fixtureNetwork === null ? '' : Object.keys(fixtureNetwork).sort().join(',');
const fixtureNetworkShape = expectedPhase === 'transition' || expectedPhase === 'verify'
  ? 'fixtureId,name,networkId'
  : 'fixtureId,name';
const fixtureNetworkIsValid = fixtureNetwork === null || (
  fixtureNetworkKeys === fixtureNetworkShape &&
  typeof fixtureNetwork.name === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(fixtureNetwork.name) &&
  typeof fixtureNetwork.fixtureId === 'string' && /^srs-continuation-20260920-[a-z0-9]{8,16}$/.test(fixtureNetwork.fixtureId) &&
  fixtureNetwork.name === `${fixtureNetwork.fixtureId}-network` &&
  (fixtureNetworkShape === 'fixtureId,name' ||
    (typeof fixtureNetwork.networkId === 'string' && /^[0-9a-f]{64}$/.test(fixtureNetwork.networkId)))
);
const imageNames = expectedPhase === 'transition' || expectedPhase === 'verify' ? ['admin-api', 'admin-web'] : [];
const validImages = Array.isArray(value?.images) && value.images.length === imageNames.length && imageNames.every((service, index) => {
  const image = value.images[index];
  return image?.service === service && /^sha256:[0-9a-f]{64}$/.test(image.imageId);
});
if (
  !record || Object.keys(value).sort().join(',') !== exactKeys.sort().join(',') ||
  value.schemaVersion !== 1 || value.phase !== expectedPhase ||
  typeof value.candidateRoot !== 'string' || !isAbsolute(value.candidateRoot) ||
  typeof value.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.treeDigest) ||
  value.temporaryProject !== `release-${value.treeDigest.slice(0, 20)}` ||
  slot?.role !== 'admin' || slot?.id !== 'default' || Object.keys(slot).length !== 2 ||
  args === null || !argumentsAreExact || !fixtureNetworkIsValid ||
  target === null || Object.keys(target).sort().join(',') !== 'postgresVolumeName,projectName,webPort' ||
  typeof target.projectName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.projectName) ||
  typeof target.postgresVolumeName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.postgresVolumeName) ||
  !Number.isSafeInteger(target.webPort) || target.webPort < 1 || target.webPort > 65535 || !validImages ||
  ((expectedPhase === 'transition' || expectedPhase === 'verify')
    ? typeof value.activeArtifactPath !== 'string' || !isAbsolute(value.activeArtifactPath)
    : value.activeArtifactPath !== null)
) {
  process.stderr.write('REFUSED: admin release plan is invalid\n');
  process.exit(1);
}
if (key === 'candidateRoot') process.stdout.write(value.candidateRoot);
else if (key === 'temporaryProject') process.stdout.write(value.temporaryProject);
else if (key === 'activeArtifactPath') process.stdout.write(value.activeArtifactPath ?? '');
else if (key.startsWith('target:')) process.stdout.write(String(target[key.slice(7)]));
else if (key === 'fixtureNetwork:name') process.stdout.write(fixtureNetwork?.name ?? '');
else if (key === 'fixtureNetwork:fixtureId') process.stdout.write(fixtureNetwork?.fixtureId ?? '');
else if (key === 'fixtureNetwork:networkId') process.stdout.write(fixtureNetwork?.networkId ?? '');
else if (key.startsWith('image:')) {
  const image = value.images.find((entry) => entry.service === key.slice(6));
  if (!image) process.exit(1);
  process.stdout.write(image.imageId);
} else process.exit(1);
NODE
}

config_target() {
  node --input-type=module - "$release_env" "$1" <<'NODE'
import { lstatSync, readFileSync } from 'node:fs';

const [path, key] = process.argv.slice(2);
let text;
try {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) throw new Error('invalid file');
  text = readFileSync(path, 'utf8');
} catch {
  process.stderr.write('REFUSED: admin release environment is missing or invalid\n');
  process.exit(1);
}
const values = new Map();
for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;
  const separator = trimmed.indexOf('=');
  if (separator < 1) continue;
  const name = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(name, value);
}
const defaults = { RELEASE_PROJECT_NAME: 'web2-admin', RELEASE_POSTGRES_VOLUME_NAME: 'web2-admin_web2admin-pg' };
const value = values.get(key) ?? defaults[key];
if (typeof value !== 'string') {
  process.stderr.write('REFUSED: admin release target is incomplete\n');
  process.exit(1);
}
if (
  ((key === 'RELEASE_PROJECT_NAME' || key === 'RELEASE_POSTGRES_VOLUME_NAME') && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) ||
  (key === 'RELEASE_WEB_PORT' && (!/^[1-9]\d*$/.test(value) || Number(value) > 65535))
) {
  process.stderr.write('REFUSED: admin release target is invalid\n');
  process.exit(1);
}
process.stdout.write(value);
NODE
}

[ "$(plan_value candidateRoot)" = "$candidate_root" ] || refuse "admin release candidate root does not match its plan"
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] || refuse "admin release compose file is missing"

project_name="$(plan_value target:projectName)"
postgres_volume_name="$(plan_value target:postgresVolumeName)"
web_port="$(plan_value target:webPort)"
fixture_network_name="$(plan_value fixtureNetwork:name)"
fixture_id="$(plan_value fixtureNetwork:fixtureId)"
fixture_network_id="$(plan_value fixtureNetwork:networkId)"
[ "$(config_target RELEASE_PROJECT_NAME)" = "$project_name" ] || refuse "admin release project does not match installed configuration"
[ "$(config_target RELEASE_POSTGRES_VOLUME_NAME)" = "$postgres_volume_name" ] || refuse "admin release database volume does not match installed configuration"
[ "$(config_target RELEASE_WEB_PORT)" = "$web_port" ] || refuse "admin release web port does not match installed configuration"

export ADMIN_RELEASE_ENV_FILE="$release_env"
export RELEASE_PROJECT_NAME="$project_name"
export RELEASE_POSTGRES_VOLUME_NAME="$postgres_volume_name"
export RELEASE_WEB_PORT="$web_port"

compose() {
  docker compose --env-file "$release_env" --project-name "$project_name" --project-directory "$backend_root" -f "$compose_file" "$@"
}

require_fixture_network() {
  [ -n "$fixture_network_name" ] || return 0
  actual_network_id="$(docker network inspect --format '{{.Id}}' "$fixture_network_name")"
  [[ "$actual_network_id" =~ ^[0-9a-f]{64}$ ]] || refuse "admin fixture network id is invalid"
  if [ -n "$fixture_network_id" ] && [ "$actual_network_id" != "$fixture_network_id" ]; then
    refuse "admin fixture network id does not match"
  fi
  [ "$(docker network inspect --format '{{.Internal}}' "$fixture_network_name")" = true ] ||
    refuse "admin fixture network is not internal"
  [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.fixture"}}' "$fixture_network_name")" = "$fixture_id" ] ||
    refuse "admin fixture network identity does not match"
  [ "$(docker network inspect --format '{{index .Labels "org.solarpunk.srs-continuation.managed"}}' "$fixture_network_name")" = true ] ||
    refuse "admin fixture network is not managed"
}

write_fixture_override() {
  local fixture_override="$1"
  [ -n "$fixture_network_name" ] || return 0
  cat > "$fixture_override" <<EOF
services:
  api:
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    networks:
      fixture:
        aliases:
          - api
          - admin-api
    ports: !reset []
  web:
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    networks:
      fixture:
        aliases:
          - admin-web
    ports: !override
      - "127.0.0.1:${web_port}:80"
  postgres:
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
    ports: !reset []
networks:
  fixture:
    external: true
    name: ${fixture_network_name}
volumes:
  web2admin-pg:
    labels:
      org.solarpunk.srs-continuation.fixture: ${fixture_id}
      org.solarpunk.srs-continuation.managed: "true"
EOF
}

require_fixture_container() {
  local container="$1"
  [ -n "$fixture_network_name" ] || return 0
  [ "$(docker inspect --format '{{index .Config.Labels "org.solarpunk.srs-continuation.fixture"}}' "$container")" = "$fixture_id" ] ||
    refuse "admin fixture container identity does not match"
  [ "$(docker inspect --format '{{index .Config.Labels "org.solarpunk.srs-continuation.managed"}}' "$container")" = true ] ||
    refuse "admin fixture container is not managed"
}

require_fixture_membership() {
  local container="$1"
  [ -n "$fixture_network_name" ] || return 0
  [ "$(docker inspect --format "{{with index .NetworkSettings.Networks \"${fixture_network_name}\"}}{{.NetworkID}}{{end}}" "$container")" = "$fixture_network_id" ] ||
    refuse "admin fixture container is not attached to the bound network"
}

require_fixture_volume() {
  [ -n "$fixture_network_name" ] || return 0
  [ "$(docker volume inspect --format '{{index .Labels "org.solarpunk.srs-continuation.fixture"}}' "$postgres_volume_name")" = "$fixture_id" ] ||
    refuse "admin fixture database identity does not match"
  [ "$(docker volume inspect --format '{{index .Labels "org.solarpunk.srs-continuation.managed"}}' "$postgres_volume_name")" = true ] ||
    refuse "admin fixture database is not managed"
}

compose_release() {
  local override="$1"
  shift
  if [ -n "$fixture_network_name" ]; then
    local fixture_override
    fixture_override="$(dirname "$plan")/admin-fixture-network-override.yml"
    [ -f "$fixture_override" ] && [ ! -L "$fixture_override" ] ||
      refuse "admin fixture network override is missing"
    compose -f "$override" -f "$fixture_override" "$@"
  else
    compose -f "$override" "$@"
  fi
}

write_images() {
  local api_image="$1"
  local web_image="$2"
  local temporary="${output}.tmp.$$"
  umask 077
  printf '{"schemaVersion":1,"images":[{"service":"admin-api","imageId":"%s"},{"service":"admin-web","imageId":"%s"}]}\n' "$api_image" "$web_image" > "$temporary"
  mv "$temporary" "$output"
}

case "$phase" in
  preflight)
    umask 077
    if [ -n "$fixture_network_name" ]; then
      require_fixture_network
      printf '{"schemaVersion":1,"fixtureNetworkId":"%s"}\n' "$actual_network_id" > "$output"
    else
      printf '%s\n' '{"schemaVersion":1}' > "$output"
    fi
    ;;
  build)
    temporary_project="$(plan_value temporaryProject)"
    docker compose --env-file "$release_env" --project-name "$temporary_project" --project-directory "$backend_root" -f "$compose_file" build api web
    api_image="$(docker image inspect --format '{{.Id}}' "${temporary_project}-api")"
    web_image="$(docker image inspect --format '{{.Id}}' "${temporary_project}-web")"
    [[ "$api_image" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "built admin API image id is invalid"
    [[ "$web_image" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "built admin web image id is invalid"
    write_images "$api_image" "$web_image"
    ;;
  transition)
    require_fixture_network
    api_image="$(plan_value image:admin-api)"
    web_image="$(plan_value image:admin-web)"
    active_artifact="$(plan_value activeArtifactPath)"
    node --input-type=module - "$active_artifact" <<'NODE'
import { lstatSync } from 'node:fs';
const stat = lstatSync(process.argv[2]);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) process.exit(1);
NODE
    override="$(dirname "$plan")/admin-image-override.yml"
    umask 077
    cat > "$override" <<EOF
services:
  api:
    image: ${api_image}
    pull_policy: never
    volumes:
      - type: bind
        source: ${active_artifact}
        target: /run/streaming-release/active-artifact.json
        read_only: true
  web:
    image: ${web_image}
    pull_policy: never
volumes:
  web2admin-pg:
    name: ${postgres_volume_name}
EOF
    if [ -n "$fixture_network_name" ]; then
      write_fixture_override "$(dirname "$plan")/admin-fixture-network-override.yml"
    fi
    api_containers="$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}" --filter 'label=com.docker.compose.service=api' --filter 'label=com.docker.compose.oneoff=False')"
    postgres_containers="$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}" --filter 'label=com.docker.compose.service=postgres' --filter 'label=com.docker.compose.oneoff=False')"
    if ! docker volume inspect "$postgres_volume_name" >/dev/null 2>&1; then
      if [ -n "$api_containers" ] || [ -n "$postgres_containers" ]; then
        refuse "admin release found installed services without their database volume"
      fi
    fi
    if [ -n "$api_containers" ]; then
      compose_release "$override" stop api
    fi
    compose_release "$override" up -d --no-build --wait --wait-timeout 120 postgres
    compose_release "$override" up -d --no-build --wait --wait-timeout 120 api
    compose_release "$override" up -d --no-build --wait --wait-timeout 120 web
    ;;
  verify)
    require_fixture_network
    override="$(dirname "$plan")/admin-image-override.yml"
    [ -f "$override" ] && [ ! -L "$override" ] || refuse "admin release image override is missing"
    api_container="$(compose_release "$override" ps -q api)"
    web_container="$(compose_release "$override" ps -q web)"
    postgres_container="$(compose_release "$override" ps -q postgres)"
    for container in "$api_container" "$web_container" "$postgres_container"; do
      [[ "$container" =~ ^[A-Za-z0-9_.:-]+$ ]] || refuse "admin release could not identify one container per service"
      [ "$(docker inspect --format '{{.State.Status}}' "$container")" = running ] || refuse "admin release service is not running"
      [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = healthy ] || refuse "admin release service is not healthy"
      require_fixture_container "$container"
    done
    require_fixture_membership "$api_container"
    require_fixture_membership "$web_container"
    require_fixture_volume
    api_image="$(docker inspect --format '{{.Image}}' "$api_container")"
    web_image="$(docker inspect --format '{{.Image}}' "$web_container")"
    postgres_image="$(docker inspect --format '{{.Image}}' "$postgres_container")"
    [ "$api_image" = "$(plan_value image:admin-api)" ] || refuse "admin API image does not match the guarded build"
    [ "$web_image" = "$(plan_value image:admin-web)" ] || refuse "admin web image does not match the guarded build"
    [[ "$postgres_image" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "admin postgres image id is invalid"
    postgres_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$postgres_container")"
    [ "$postgres_mount" = "$postgres_volume_name" ] || refuse "admin database volume does not match the guarded target"
    artifact_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/streaming-release/active-artifact.json"}}{{.Source}}|{{.RW}}{{end}}{{end}}' "$api_container")"
    [ "$artifact_mount" = "$(plan_value activeArtifactPath)|false" ] || refuse "admin active artifact mount does not match the guarded receipt"
    [ "$(docker port "$web_container" 80/tcp)" = "127.0.0.1:${web_port}" ] || refuse "admin web port does not match the guarded target"
    write_images "$api_image" "$web_image"
    ;;
esac
