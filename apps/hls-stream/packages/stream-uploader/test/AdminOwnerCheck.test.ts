/**
 * The boot check that this service signs as the owner the admin knows for its stage. See
 * `src/libs/AdminOwnerCheck.ts`.
 *
 * Every stage signs with a key of its own, so the owner compared is the one the admin names for this
 * service's token at `/api/internal/stages/self`. A 404 there, an admin from before stages or the
 * intermediate admin answering the shared token, falls back to the catalog owner the public config
 * names. A read that fails is a warning, and the publish gate compares each declaration's owner anyway.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageSelfOutcome } from '../src/libs/AdminApiClient.js';
import { assertAdminSignsAsThisService, type AdminOwnerSource } from '../src/libs/AdminOwnerCheck.js';

const SIGNER = '3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
const STAGE_ID = '5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f';
const OTHER = '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09';

/** An admin answering `self` and `config` as given, recording which it was asked. */
function admin(self: StageSelfOutcome, config: string | null = null) {
  const asked: string[] = [];
  const source: AdminOwnerSource = {
    describe: () => 'http://admin.example.org',
    fetchStageSelf: async () => {
      asked.push('self');
      return self;
    },
    fetchFeedOwner: async () => {
      asked.push('config');
      return config;
    },
  };
  return { source, asked };
}

function recorder() {
  const lines: { level: 'info' | 'warn'; text: string }[] = [];
  return {
    lines,
    logger: {
      info: (text: string) => lines.push({ level: 'info', text }),
      warn: (text: string) => lines.push({ level: 'warn', text }),
    },
  };
}

describe('the boot check against the owner the admin knows for this stage', () => {
  it('starts when the stage the admin names signs as this service, whatever the case and prefix', async () => {
    const { source, asked } = admin({ kind: 'stage', stageId: STAGE_ID, owner: `0x${SIGNER.toUpperCase()}` });
    const { lines, logger } = recorder();

    await assertAdminSignsAsThisService(source, SIGNER, logger);

    assert.deepEqual(asked, ['self'], 'the catalog owner is not asked once the stage is known');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, 'info');
    assert.match(lines[0]!.text, new RegExp(STAGE_ID));
  });

  it('refuses to start when the stage signs as another address, naming both and what to fix', async () => {
    const { source } = admin({ kind: 'stage', stageId: STAGE_ID, owner: OTHER });

    await assert.rejects(
      () => assertAdminSignsAsThisService(source, SIGNER, recorder().logger),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(OTHER) &&
        error.message.includes(SIGNER) &&
        error.message.includes('the owner the admin knows for this stage') &&
        /STREAM_KEY in the manager, or the stage/.test(error.message),
    );
  });

  it('refuses to start on a mismatch even when the catalog owner would match', async () => {
    const { source, asked } = admin({ kind: 'stage', stageId: STAGE_ID, owner: OTHER }, SIGNER);

    await assert.rejects(() => assertAdminSignsAsThisService(source, SIGNER, recorder().logger));
    assert.deepEqual(asked, ['self']);
  });
});

describe('the boot check on a token the admin ties to no stage', () => {
  it('falls back to the catalog owner and starts when it is this service’s', async () => {
    const { source, asked } = admin({ kind: 'no-stage' }, `0x${SIGNER}`);
    const { lines, logger } = recorder();

    await assertAdminSignsAsThisService(source, SIGNER, logger);

    assert.deepEqual(asked, ['self', 'config']);
    assert.equal(lines[0]!.level, 'info');
  });

  it('refuses to start when the catalog owner is another address, naming both, and the STREAM_KEY fix first', async () => {
    const { source } = admin({ kind: 'no-stage' }, OTHER);

    await assert.rejects(
      () => assertAdminSignsAsThisService(source, SIGNER, recorder().logger),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(OTHER) &&
        error.message.includes(SIGNER) &&
        /Fix this deployment's STREAM_KEY in the manager.*, or, on the intermediate admin, give it a token of its own/.test(
          error.message,
        ),
    );
  });

  it('only warns when the catalog owner cannot be read either', async () => {
    const { source } = admin({ kind: 'no-stage' }, null);
    const { lines, logger } = recorder();

    await assertAdminSignsAsThisService(source, SIGNER, logger);

    assert.deepEqual(
      lines.map((line) => line.level),
      ['warn'],
    );
  });
});

describe('the boot check against an admin that cannot be read', () => {
  it('only warns, and does not compare with the catalog owner, which is not this stage’s', async () => {
    const { source, asked } = admin({ kind: 'unconfirmed', reason: 'the admin did not answer' }, OTHER);
    const { lines, logger } = recorder();

    await assertAdminSignsAsThisService(source, SIGNER, logger);

    assert.deepEqual(asked, ['self']);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, 'warn');
    assert.match(lines[0]!.text, /the admin did not answer/);
  });
});
