import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const adapter = join(repositoryRoot, 'web2-admin/backend/release-adapter.sh');
const releaseCompose = join(repositoryRoot, 'web2-admin/backend/release-compose.yml');
const target = {
  projectName: 'admin-test',
  postgresVolumeName: 'admin-test-pg',
  webPort: 18081,
};
const fixtureNetwork = {
  name: 'srs-continuation-20260920-a1b2c3d4-network',
  fixtureId: 'srs-continuation-20260920-a1b2c3d4',
};
const fixtureNetworkId = 'd'.repeat(64);
const adminDatabaseNetworkName = `${target.projectName}-fixture-db`;
const adminDatabaseNetworkId = 'f'.repeat(64);

function mergedFixtureCompose(
  overrides: {
    apiNetworks?: string[];
    postgresNetworks?: string[];
    webNetworks?: string[];
  } = {},
) {
  const networks = (names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
  return {
    name: target.projectName,
    services: {
      api: { networks: networks(overrides.apiNetworks ?? ['admin-db', 'fixture']) },
      postgres: { networks: networks(overrides.postgresNetworks ?? ['admin-db']) },
      web: { networks: networks(overrides.webNetworks ?? ['fixture']) },
    },
    networks: {
      'admin-db': {
        name: adminDatabaseNetworkName,
        internal: true,
        labels: {
          'org.solarpunk.srs-continuation.fixture': fixtureNetwork.fixtureId,
          'org.solarpunk.srs-continuation.managed': 'true',
        },
      },
      fixture: {
        name: fixtureNetwork.name,
        external: true,
      },
    },
  };
}

async function temporaryRoot(t: {
  after(callback: () => Promise<void>): void;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'admin-release-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function plan(
  phase: string,
  activeArtifactPath: string | null = null,
  network?: typeof fixtureNetwork,
) {
  const treeDigest = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    phase,
    temporaryProject: `release-${treeDigest.slice(0, 20)}`,
    candidateRoot: repositoryRoot,
    treeDigest,
    slot: { role: 'admin', id: 'default' },
    images: phase === 'transition' || phase === 'verify'
      ? [
          { service: 'admin-api', imageId: `sha256:${'b'.repeat(64)}` },
          { service: 'admin-web', imageId: `sha256:${'c'.repeat(64)}` },
        ]
      : [],
    activeArtifactPath,
    arguments: {
      target: { ...target },
      ...(network === undefined
        ? {}
        : {
            fixtureNetwork: {
              ...network,
              ...(phase === 'preflight' ? {} : { networkId: fixtureNetworkId }),
            },
          }),
    },
  };
}

async function writeReleaseEnvironment(root: string): Promise<string> {
  const home = join(root, 'home');
  const config = join(home, '.config/web2-admin');
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, 'release.env'),
    `RELEASE_PROJECT_NAME=${target.projectName}\n` +
      `RELEASE_POSTGRES_VOLUME_NAME=${target.postgresVolumeName}\n` +
      `RELEASE_WEB_PORT=${String(target.webPort)}\n` +
      'POSTGRES_PASSWORD=synthetic-test-password\n',
    { mode: 0o600 },
  );
  return home;
}

describe('fixed admin release adapter', () => {
  it('overrides reference-file credentials from the role-scoped process environment', async () => {
    const compose = await readFile(releaseCompose, 'utf8');
    for (const name of [
      'BEE_URL',
      'FEED_PRIVATE_KEY',
      'INGEST_SRT_PASSPHRASE',
      'INTERNAL_API_TOKEN',
      'POSTAGE_BATCH_ID',
    ]) {
      assert.match(compose, new RegExp(`^      ${name}: \\${'${'}${name}`, 'm'));
    }
    assert.equal(compose.match(/^ {6}POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:/gm)?.length, 2);
    assert.doesNotMatch(compose, /^ {6}DATABASE_URL:/m);
  });

  it('preserves routed process credentials without copying their values into its output', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const routed = {
      BEE_URL: 'http://synthetic-bee.invalid:1633',
      FEED_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      INGEST_SRT_PASSPHRASE: 'synthetic-passphrase',
      INTERNAL_API_TOKEN: 'synthetic-internal-token-000000000',
      POSTAGE_BATCH_ID: '2'.repeat(64),
      POSTGRES_PASSWORD: 'synthetic:@/#?% password',
    };
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
[ "${'$'}BEE_URL" = '${routed.BEE_URL}' ]
[ "${'$'}FEED_PRIVATE_KEY" = '${routed.FEED_PRIVATE_KEY}' ]
[ "${'$'}INGEST_SRT_PASSPHRASE" = '${routed.INGEST_SRT_PASSPHRASE}' ]
[ "${'$'}INTERNAL_API_TOKEN" = '${routed.INTERNAL_API_TOKEN}' ]
[ "${'$'}POSTAGE_BATCH_ID" = '${routed.POSTAGE_BATCH_ID}' ]
[ "${'$'}POSTGRES_PASSWORD" = '${routed.POSTGRES_PASSWORD}' ]
if [ "$1" = image ]; then printf 'sha256:%s\n' "$(printf a%.0s {1..64})"; fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const planPath = join(root, 'build-plan.json');
    const output = join(root, 'build.json');
    await writeFile(planPath, JSON.stringify(plan('build')));

    const result = await execFileAsync(
      adapter,
      ['build', '--plan', planPath, '--output', output],
      {
        env: {
          ...process.env,
          ...routed,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      },
    );

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const serialized = JSON.stringify(JSON.parse(await readFile(output, 'utf8')));
    for (const secret of Object.values(routed)) assert.doesNotMatch(serialized, new RegExp(secret));
  });

  it('accepts the guard-resolved fixture network while building isolated images', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const docker = join(bin, 'docker');
    await writeFile(
      docker,
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${root}/docker-calls"
if [ "$1" = "image" ]; then
  case "${'$'}5" in
    *-api-*) printf 'sha256:%s\\n' "$(printf a%.0s {1..64})" ;;
    *) printf 'sha256:%s\\n' "$(printf b%.0s {1..64})" ;;
  esac
fi
`,
    );
    await chmod(docker, 0o700);
    const planPath = join(root, 'build-plan.json');
    const output = join(root, 'build.json');
    await writeFile(planPath, JSON.stringify(plan('build', null, fixtureNetwork)));

    await execFileAsync(adapter, ['build', '--plan', planPath, '--output', output], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    const result = JSON.parse(await readFile(output, 'utf8')) as {
      images: Array<{ service: string; imageId: string }>;
    };
    assert.deepEqual(result.images.map(({ service }) => service), [
      'admin-api',
      'admin-web',
    ]);
    assert.ok(result.images.every(({ imageId }) => /^sha256:[0-9a-f]{64}$/.test(imageId)));
    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.match(calls, /release-compose\.yml build api web/);
    assert.match(calls, /--project-name release-aaaaaaaaaaaaaaaaaaaa/);
    assert.match(calls, /image inspect .*release-aaaaaaaaaaaaaaaaaaaa-api/);
    assert.match(calls, /image inspect .*release-aaaaaaaaaaaaaaaaaaaa-web/);
  });

  it('refuses a plan that retargets the installed project', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const planPath = join(root, 'preflight-plan.json');
    const output = join(root, 'preflight.json');
    const changed = plan('preflight');
    changed.arguments.target.projectName = 'another-project';
    await writeFile(planPath, JSON.stringify(changed));

    await assert.rejects(
      execFileAsync(
        adapter,
        ['preflight', '--plan', planPath, '--output', output],
        { env: { ...process.env, HOME: home } },
      ),
      (error: Error & { stderr?: string }) => {
        assert.match(
          error.stderr ?? '',
          /project does not match installed configuration/,
        );
        return true;
      },
    );
  });

  it('preflights and returns the exact bound fixture network id', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
if [ "$1" = network ] && [ "$2" = inspect ]; then
  case "$4" in
    *'.Id'*) printf '%s\n' '${fixtureNetworkId}' ;;
    *Internal*) printf '%s\n' true ;;
    *fixture*) printf '%s\n' '${fixtureNetwork.fixtureId}' ;;
    *managed*) printf '%s\n' true ;;
  esac
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const planPath = join(root, 'preflight-plan.json');
    const output = join(root, 'preflight.json');
    await writeFile(planPath, JSON.stringify(plan('preflight', null, fixtureNetwork)));

    await execFileAsync(adapter, ['preflight', '--plan', planPath, '--output', output], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      schemaVersion: 1,
      fixtureNetworkId,
    });
  });

  it('stops the old API before starting and verifying the guarded services', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${root}/docker-calls"
if [ "$1" = volume ] && [ "$2" = inspect ]; then
  printf '%s\\n' '${target.postgresVolumeName}'
elif [ "$1" = ps ]; then
  if [[ "$*" == *service=api* ]]; then printf '%s\\n' old-api; fi
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const planPath = join(root, 'transition-plan.json');
    const activeArtifactPath = join(root, 'active-artifact.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(
      planPath,
      JSON.stringify(plan('transition', activeArtifactPath)),
    );

    await execFileAsync(adapter, ['transition', '--plan', planPath], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    const lines = calls.trim().split('\n');
    const stop = lines.findIndex((line) => line.endsWith(' stop api'));
    const api = lines.findIndex(
      (line) => line.includes(' up -d --no-build --wait ') && line.endsWith(' api'),
    );
    const web = lines.findIndex(
      (line) => line.includes(' up -d --no-build --wait ') && line.endsWith(' web'),
    );
    assert.ok(stop >= 0 && api > stop && web > api);
    const override = await readFile(join(root, 'admin-image-override.yml'), 'utf8');
    assert.match(override, new RegExp(`image: sha256:${'b'.repeat(64)}`));
    assert.match(override, new RegExp(`image: sha256:${'c'.repeat(64)}`));
    assert.match(override, new RegExp(`source: ${activeArtifactPath}`));
    assert.match(override, /target: \/run\/streaming-release\/active-artifact\.json/);
    assert.match(override, /read_only: true/);
  });

  it('does not start the web service when the new API migration or health check fails', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${root}/docker-calls"
if [ "$1" = volume ]; then exit 0; fi
if [ "$1" = ps ] && [[ "$*" == *service=api* ]]; then printf '%s\\n' old-api; fi
if [ "$1" = compose ] && [[ "$*" == *' up '* ]] && [ "${'$'}{!#}" = api ]; then exit 42; fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const activeArtifactPath = join(root, 'active-artifact.json');
    const planPath = join(root, 'transition-plan.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(planPath, JSON.stringify(plan('transition', activeArtifactPath)));

    await assert.rejects(
      execFileAsync(adapter, ['transition', '--plan', planPath], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      }),
    );

    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.match(calls, / up -d --no-build --wait --wait-timeout 120 api/);
    assert.doesNotMatch(calls, / up -d --no-build --wait --wait-timeout 120 web/);
  });

  it('joins only the bound internal fixture network and labels guard-owned resources', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(root, 'merged-compose.json'),
      JSON.stringify(mergedFixtureCompose()),
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${root}/docker-calls"
if [ "$1" = compose ] && [[ "$*" == *' config --format json'* ]]; then
  cat "${root}/merged-compose.json"
elif [ "$1" = network ] && [ "$2" = inspect ]; then
  case "$4" in
    *'.Id'*) printf '%s\n' '${fixtureNetworkId}' ;;
    *Internal*) printf '%s\n' true ;;
    *fixture*) printf '%s\n' '${fixtureNetwork.fixtureId}' ;;
    *managed*) printf '%s\n' true ;;
  esac
elif [ "$1" = volume ] && [ "$2" = inspect ]; then
  printf '%s\n' '${target.postgresVolumeName}'
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const activeArtifactPath = join(root, 'active-artifact.json');
    const planPath = join(root, 'transition-plan.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(
      planPath,
      JSON.stringify(plan('transition', activeArtifactPath, fixtureNetwork)),
    );

    await execFileAsync(adapter, ['transition', '--plan', planPath], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.match(calls, new RegExp(`network inspect .* ${fixtureNetwork.name}`));
    assert.match(calls, / config --format json/);
    const override = await readFile(join(root, 'admin-fixture-network-override.yml'), 'utf8');
    assert.match(override, new RegExp(`name: ${fixtureNetwork.name}`));
    assert.match(override, /external: true/);
    assert.match(override, new RegExp(`org\\.solarpunk\\.srs-continuation\\.fixture: ${fixtureNetwork.fixtureId}`));
    assert.match(override, /org\.solarpunk\.srs-continuation\.managed: "true"/);
    assert.match(override, /aliases:\n\s+- api\n\s+- admin-api/);
    assert.match(override, /aliases:\n\s+- admin-web/);
    assert.match(override, new RegExp(`name: ${adminDatabaseNetworkName}`));
    assert.match(override, /admin-db:\n\s+name: [^\n]+\n\s+internal: true/);
    assert.match(override, /api:[\s\S]*networks:[\s\S]*admin-db:[\s\S]*fixture:/);
    assert.match(override, /postgres:[\s\S]*networks:\n\s+admin-db:/);
    assert.match(override, /api:[\s\S]*ports: !reset \[\]/);
    assert.match(override, /postgres:[\s\S]*ports: !reset \[\]/);
    assert.match(override, new RegExp(`127\\.0\\.0\\.1:${String(target.webPort)}:80`));
  });

  it('refuses a merged fixture topology that isolates the API from Postgres', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(root, 'merged-compose.json'),
      JSON.stringify(mergedFixtureCompose({ apiNetworks: ['fixture'] })),
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${root}/docker-calls"
if [ "$1" = compose ] && [[ "$*" == *' config --format json'* ]]; then
  cat "${root}/merged-compose.json"
elif [ "$1" = network ] && [ "$2" = inspect ]; then
  case "$4" in
    *'.Id'*) printf '%s\n' '${fixtureNetworkId}' ;;
    *Internal*) printf '%s\n' true ;;
    *fixture*) printf '%s\n' '${fixtureNetwork.fixtureId}' ;;
    *managed*) printf '%s\n' true ;;
  esac
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const activeArtifactPath = join(root, 'active-artifact.json');
    const planPath = join(root, 'transition-plan.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(
      planPath,
      JSON.stringify(plan('transition', activeArtifactPath, fixtureNetwork)),
    );

    await assert.rejects(
      execFileAsync(adapter, ['transition', '--plan', planPath], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      }),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /fixture compose topology is invalid/);
        return true;
      },
    );
    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.doesNotMatch(calls, / up /);
  });

  it('refuses a fixture network with the wrong identity before starting services', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${root}/docker-calls"
if [ "$1" = network ] && [ "$2" = inspect ]; then
  case "$4" in
    *'.Id'*) printf '%s\n' '${fixtureNetworkId}' ;;
    *Internal*) printf '%s\n' true ;;
    *fixture*) printf '%s\n' wrong-fixture ;;
    *managed*) printf '%s\n' true ;;
  esac
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);
    const activeArtifactPath = join(root, 'active-artifact.json');
    const planPath = join(root, 'transition-plan.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(
      planPath,
      JSON.stringify(plan('transition', activeArtifactPath, fixtureNetwork)),
    );

    await assert.rejects(
      execFileAsync(adapter, ['transition', '--plan', planPath], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      }),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /fixture network identity does not match/);
        return true;
      },
    );
    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.doesNotMatch(calls, / up /);
  });

  it('verifies exact images, database, fixture membership and loopback port', async (t) => {
    const root = await temporaryRoot(t);
    const home = await writeReleaseEnvironment(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const activeArtifactPath = join(root, 'active-artifact.json');
    const planPath = join(root, 'verify-plan.json');
    const output = join(root, 'verify.json');
    await writeFile(activeArtifactPath, '{"schemaVersion":1}');
    await writeFile(join(root, 'admin-image-override.yml'), 'services: {}\n');
    await writeFile(join(root, 'admin-fixture-network-override.yml'), 'services: {}\n');
    await writeFile(
      join(root, 'merged-compose.json'),
      JSON.stringify(mergedFixtureCompose()),
    );
    await writeFile(
      planPath,
      JSON.stringify(plan('verify', activeArtifactPath, fixtureNetwork)),
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${root}/docker-calls"
if [ "$1" = network ] && [ "$2" = inspect ]; then
  case "$4" in
    *'.Id'*)
      if [ "$5" = '${adminDatabaseNetworkName}' ]; then printf '%s\\n' '${adminDatabaseNetworkId}'
      else printf '%s\\n' '${fixtureNetworkId}'
      fi
      ;;
    *Internal*) printf '%s\\n' true ;;
    *fixture*) printf '%s\\n' '${fixtureNetwork.fixtureId}' ;;
    *managed*) printf '%s\\n' true ;;
  esac
elif [ "$1" = volume ] && [ "$2" = inspect ]; then
  case "$4" in
    *fixture*) printf '%s\\n' '${fixtureNetwork.fixtureId}' ;;
    *managed*) printf '%s\\n' true ;;
  esac
elif [ "$1" = compose ] && [[ "$*" == *' config --format json'* ]]; then
  cat "${root}/merged-compose.json"
elif [ "$1" = compose ] && [[ "$*" == *' ps -q '* ]]; then
  case "${'$'}{!#}" in
    api) printf '%s\\n' admin-api-container ;;
    web) printf '%s\\n' admin-web-container ;;
    postgres) printf '%s\\n' admin-postgres-container ;;
  esac
elif [ "$1" = inspect ]; then
  format="$3"
  container="${'$'}{!#}"
  if [[ "$format" == *State.Status* ]]; then printf '%s\\n' running
  elif [[ "$format" == *State.Health* ]]; then printf '%s\\n' healthy
  elif [[ "$format" == *Config.Labels*fixture* ]]; then printf '%s\\n' '${fixtureNetwork.fixtureId}'
  elif [[ "$format" == *Config.Labels*managed* ]]; then printf '%s\\n' true
  elif [[ "$format" == *NetworkSettings* ]]; then
    if [[ "$format" == *'${fixtureNetwork.name}'* ]]; then
      case "$container" in
        admin-api-container|admin-web-container) printf '%s\\n' '${fixtureNetworkId}' ;;
      esac
    elif [[ "$format" == *'${adminDatabaseNetworkName}'* ]]; then
      case "$container" in
        admin-api-container|admin-postgres-container) printf '%s\\n' '${adminDatabaseNetworkId}' ;;
      esac
    fi
  elif [[ "$format" == *'.Image'* ]]; then
    case "$container" in
      admin-api-container) printf 'sha256:%s\\n' "$(printf b%.0s {1..64})" ;;
      admin-web-container) printf 'sha256:%s\\n' "$(printf c%.0s {1..64})" ;;
      admin-postgres-container) printf 'sha256:%s\\n' "$(printf e%.0s {1..64})" ;;
    esac
  elif [[ "$format" == *'/var/lib/postgresql/data'* ]]; then printf '%s\\n' '${target.postgresVolumeName}'
  elif [[ "$format" == *'/run/streaming-release/active-artifact.json'* ]]; then printf '%s|false\\n' '${activeArtifactPath}'
  fi
elif [ "$1" = port ]; then
  printf '127.0.0.1:%s\\n' '${String(target.webPort)}'
fi
`,
    );
    await chmod(join(bin, 'docker'), 0o700);

    await execFileAsync(
      adapter,
      ['verify', '--plan', planPath, '--output', output],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      },
    );

    const result = JSON.parse(await readFile(output, 'utf8')) as {
      images: Array<{ service: string; imageId: string }>;
    };
    assert.deepEqual(result.images, [
      { service: 'admin-api', imageId: `sha256:${'b'.repeat(64)}` },
      { service: 'admin-web', imageId: `sha256:${'c'.repeat(64)}` },
    ]);
    const calls = await readFile(join(root, 'docker-calls'), 'utf8');
    assert.match(calls, new RegExp(`network inspect .* ${adminDatabaseNetworkName}`));
    assert.match(calls, new RegExp(`${adminDatabaseNetworkName}.*admin-api-container`));
    assert.match(calls, new RegExp(`${adminDatabaseNetworkName}.*admin-postgres-container`));
    assert.match(calls, new RegExp(`${adminDatabaseNetworkName}.*admin-web-container`));
    assert.match(calls, new RegExp(`${fixtureNetwork.name}.*admin-postgres-container`));
  });
});
