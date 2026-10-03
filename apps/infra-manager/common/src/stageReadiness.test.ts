/**
 * A stage's readiness as the manager hands it to the web2 admin: the console's
 * verdict in the admin's four words, and every step that is not ok as a reason.
 *
 * Unit test. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAGE_READINESS_TONES, stageReadinessSchema } from '@streaming-monorepo/contracts';

import type { ReadinessProfile } from './deploymentShape.js';
import {
  readinessFor,
  readinessInputOf,
  type ReadinessTone,
  STAGE_READINESS_OF_TONE,
  stageReadinessOf,
} from './readiness.js';
import { stampHealthFrom } from './stampHealth.js';
import { stageRegistrationLine } from './stagePush.js';

const BATCH = 'a'.repeat(64);
const POOL = ['360p', '480p', '720p', '1080p']
  .map((rung, index) => `${rung}@http://10.200.0.1:${10015 + index * 10}<${String(index + 1).repeat(64)}>`)
  .join(' ');

const abrUploader: ReadinessProfile = {
  name: 'stage-one',
  kind: 'abr-uploader',
  components: ['srs', 'stream-uploader'],
  bee_publishers: POOL,
  status: 'RUNNING',
  containers: [{ service: 'srs' }, { service: 'stream-uploader' }],
};

const streamer: ReadinessProfile = {
  name: 'stage-two',
  kind: 'streamer',
  stamp_id: BATCH,
  status: 'RUNNING',
  containers: [{ service: 'srs' }, { service: 'stream-uploader' }, { service: 'bee-uploader' }],
};

const paying = { state: 'ok' as const, availablePlur: 10n ** 17n, floorPlur: 5n * 10n ** 15n };
const activeStamp = stampHealthFrom(BATCH, [{ batchID: BATCH, usable: true, batchTTL: 30 * 86_400 }]);

describe('a console tone on a stage record', () => {
  it('maps every tone onto one of the contract’s four', () => {
    const tones: ReadinessTone[] = ['ok', 'warn', 'err', 'info', 'gray'];
    for (const tone of tones) {
      assert.ok((STAGE_READINESS_TONES as readonly string[]).includes(STAGE_READINESS_OF_TONE[tone]), tone);
    }
    assert.deepEqual(STAGE_READINESS_OF_TONE, {
      ok: 'ready',
      warn: 'warning',
      err: 'blocked',
      gray: 'blocked',
      info: 'unknown',
    });
  });
});

describe('the readiness a stage record carries', () => {
  it('is ready with no reasons for a running pool uploader whose uploader reports healthy', () => {
    const verdict = stageReadinessOf(
      readinessInputOf(abrUploader, undefined, null, { uploaderHealth: { state: 'ok', reasons: [] } }),
    );
    assert.deepEqual(verdict, { tone: 'ready', reasons: [] });
    assert.ok(stageReadinessSchema.safeParse(verdict).success);
  });

  it('is ready for a streamer whose own node pays and whose batch is live', () => {
    const verdict = stageReadinessOf(
      readinessInputOf(streamer, activeStamp, paying, { uploaderHealth: { state: 'ok', reasons: [] } }),
    );
    assert.equal(verdict.tone, 'ready');
  });

  it('is a warning, with the console’s own label first, for an uploader waiting for its node', () => {
    const input = readinessInputOf(abrUploader, undefined, null, {
      uploaderHealth: { state: 'waiting_for_node', reasons: ['node_unavailable'] },
    });
    const verdict = stageReadinessOf(input);
    assert.equal(verdict.tone, 'warning');
    assert.equal(verdict.reasons[0], readinessFor(input).label);
  });

  it('is blocked for a stopped stage and for an empty chequebook', () => {
    assert.equal(stageReadinessOf(readinessInputOf({ ...abrUploader, status: 'STOPPED' })).tone, 'blocked');
    const empty = { state: 'empty' as const, availablePlur: 0n, floorPlur: 5n * 10n ** 15n };
    const verdict = stageReadinessOf(readinessInputOf(streamer, activeStamp, empty));
    assert.equal(verdict.tone, 'blocked');
    assert.ok(verdict.reasons.includes('Chequebook empty'));
  });

  it('is unknown while the stage deploys', () => {
    assert.equal(stageReadinessOf(readinessInputOf({ ...abrUploader, status: 'DEPLOYING' })).tone, 'unknown');
  });

  it('lists every step that is not ok, not only the first', () => {
    const verdict = stageReadinessOf(
      readinessInputOf(streamer, stampHealthFrom(BATCH, null), null, {
        uploaderHealth: { state: 'unhealthy', reasons: ['postage_refused'] },
      }),
    );
    assert.ok(verdict.reasons.length >= 2, verdict.reasons.join(' | '));
  });
});

describe('the deployment page’s registration line', () => {
  it('names the outcome and how long ago in whole seconds', () => {
    const at = '2026-09-28T10:00:00.000Z';
    assert.equal(
      stageRegistrationLine({ outcome: 'stored', at }, Date.parse(at) + 12_400),
      'Web2 admin registration: registered 12 s ago',
    );
  });

  it('says so before the first push', () => {
    assert.equal(stageRegistrationLine(null, Date.now()), 'Web2 admin registration: not pushed yet');
  });
});
