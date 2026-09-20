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

async function temporaryRoot(t: {
  after(callback: () => Promise<void>): void;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'admin-release-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function plan(phase: string, activeArtifactPath: string | null = null) {
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
    arguments: {},
  };
}

describe('fixed admin release adapter', () => {
  it('builds isolated backend and frontend images and returns immutable ids', async (t) => {
    const root = await temporaryRoot(t);
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
    await writeFile(planPath, JSON.stringify(plan('build')));

    await execFileAsync(adapter, ['build', '--plan', planPath, '--output', output], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
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
    assert.match(calls, /web2-admin\/backend\/Dockerfile/);
    assert.match(calls, /web2-admin\/frontend\/Dockerfile/);
    assert.match(calls, /streaming-admin-api-release-aaaaaaaaaaaaaaaaaaaa/);
    assert.match(calls, /streaming-admin-web-release-aaaaaaaaaaaaaaaaaaaa/);
  });

  it('fails closed before service movement without a fixed production coordinator', async (t) => {
    const root = await temporaryRoot(t);
    const planPath = join(root, 'transition-plan.json');
    const activeArtifactPath = join(root, 'active-artifact.json');
    await writeFile(activeArtifactPath, '{}');
    await writeFile(
      planPath,
      JSON.stringify(plan('transition', activeArtifactPath)),
    );

    await assert.rejects(
      execFileAsync(adapter, ['transition', '--plan', planPath]),
      (error: Error & { stderr?: string }) => {
        assert.match(
          error.stderr ?? '',
          /admin production release coordinator is not configured/,
        );
        return true;
      },
    );
  });
});
