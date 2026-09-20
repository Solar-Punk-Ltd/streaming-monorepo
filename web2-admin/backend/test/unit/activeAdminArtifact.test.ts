import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { loadActiveAdminArtifact } from '../../src/utils/activeAdminArtifact.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'active-admin-artifact-'));
  roots.push(root);
  return root;
}

function descriptor() {
  return {
    schemaVersion: 1,
    installationId: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    slot: { role: 'admin', id: 'default' },
    artifact: {
      treeDigest: 'a'.repeat(64),
      images: [
        { service: 'admin', imageId: `sha256:${'b'.repeat(64)}` },
      ],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe('active admin artifact metadata', () => {
  it('loads one strict bounded deployment descriptor', () => {
    const path = join(temporaryRoot(), 'active-artifact.json');
    writeFileSync(path, JSON.stringify(descriptor()), { mode: 0o444 });
    assert.deepEqual(loadActiveAdminArtifact(path), descriptor());
  });

  it('refuses a symlink, wrong slot, and an oversized file', () => {
    const root = temporaryRoot();
    const real = join(root, 'real.json');
    const linked = join(root, 'linked.json');
    writeFileSync(real, JSON.stringify(descriptor()));
    symlinkSync(real, linked);
    assert.equal(loadActiveAdminArtifact(linked), null);

    const wrong = join(root, 'wrong.json');
    writeFileSync(
      wrong,
      JSON.stringify({
        ...descriptor(),
        slot: { role: 'viewer', id: 'default' },
      }),
    );
    assert.equal(loadActiveAdminArtifact(wrong), null);

    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(65_537));
    assert.equal(loadActiveAdminArtifact(oversized), null);
  });
});
