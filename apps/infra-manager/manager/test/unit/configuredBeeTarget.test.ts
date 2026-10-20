import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { ConfiguredBeeTargetResolver } from '../../src/domain/chequebook/ConfiguredBeeTargetResolver.js';
import { ChequebookPreparationError } from '../../src/domain/errors/ChequebookPreparationError.js';
import { ChequebookProfileChangedError } from '../../src/domain/errors/ChequebookProfileChangedError.js';
import { ChequebookTargetChangedError } from '../../src/domain/errors/ChequebookTargetChangedError.js';
import type { Profile } from '../../src/types/index.js';

const profile = {
  instance_id: '11111111-1111-4111-8111-111111111111',
  name: 'deployment',
  port_slot: 1,
  host: 'bee-host',
  kind: 'streamer',
  components: null,
  status: 'RUNNING',
  created_at: new Date(0),
  updated_at: new Date(0),
  stack_version_id: 1,
} as Profile;
const bee = { service: 'bee-uploader', ports: { BEE_UPLOADER_API_PORT: 12005 } };
/** The SQL ownership the journal admits a transfer under, as the resolver captures it: only its shape matters here. */
const captured = Object.freeze({
  version: 1 as const,
  profile: {
    name: profile.name,
    instanceId: profile.instance_id,
    intentRevision: 1,
    engineConfigRevision: 1,
    kind: profile.kind,
    components: null,
    host: profile.host,
    portSlot: profile.port_slot,
    stackVersionId: 1,
    status: profile.status,
  },
  alias: 'bee-host',
  daemonId: 'daemon',
  verifiedAt: '2026-01-01T00:00:00.000000Z',
  reservation: {
    id: 1,
    protocol: 'tcp' as const,
    port: 12005,
    service: 'bee-uploader' as const,
    portVar: 'BEE_UPLOADER_API_PORT' as const,
  },
});
/** The ownership as captured, its reservation owning `port`. */
const reserving = (port: number) => Object.freeze({ ...captured, reservation: { ...captured.reservation, port } });

/** Resolves and expects a preparation refusal with exactly `cause`: the cause is asserted, never the sentence. */
async function refusedWith(promise: Promise<unknown>, cause: ChequebookRefusalCause) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChequebookPreparationError, `a preparation refusal, not ${String(error)}`);
    assert.equal(error.refusal.cause, cause);
    return true;
  });
}

function resolver(
  options: {
    current?: Profile | null;
    containers?: { service: string; ports: Record<string, number> }[];
    capture?: () => Promise<typeof captured>;
    onCapture?: () => void;
  } = {},
) {
  return new ConfiguredBeeTargetResolver(
    { findByName: async () => (options.current === undefined ? profile : options.current) },
    {
      listApiContainers: async () =>
        (options.containers ?? [bee]).map((container) => ({
          ...container,
          buildId: null,
          buildCommit: null,
          buildLabel: null,
        })),
    },
    async () => {
      options.onCapture?.();
      return (options.capture ?? (async () => captured))();
    },
  );
}

describe('configured Bee target locator', () => {
  it('refuses with no Bee container recorded for the deployment as bee_container_not_found', async () => {
    await refusedWith(resolver({ containers: [] }).resolve('deployment'), 'bee_container_not_found');
    await refusedWith(
      resolver({ containers: [{ service: 'stream-uploader', ports: { BEE_UPLOADER_API_PORT: 12005 } }] }).resolve(
        'deployment',
      ),
      'bee_container_not_found',
    );
  });

  it('refuses two Bee containers recorded for one deployment as target_changed', async () => {
    await refusedWith(resolver({ containers: [bee, bee] }).resolve('deployment'), 'target_changed');
  });

  it('refuses a recorded Bee API port that is missing or out of range as bee_container_unsupported', async () => {
    for (const ports of [{}, ...[0, 65536, 1.5, NaN].map((port) => ({ BEE_UPLOADER_API_PORT: port }))]) {
      await refusedWith(
        resolver({ containers: [{ ...bee, ports }] }).resolve('deployment'),
        'bee_container_unsupported',
      );
    }
  });

  it("refuses a recorded port that is not the one the deployment's reservation owns, as bee_container_unsupported", async () => {
    // The container still records 12005, but the reservation now says the deployment owns 12015: 12005 may since
    // have been given to another deployment, so it is never dialled.
    await refusedWith(
      resolver({ capture: async () => reserving(12015) }).resolve('deployment'),
      'bee_container_unsupported',
    );
    // The other way round: the reservation still owns 12005, the container moved to 12015.
    await refusedWith(
      resolver({ containers: [{ ...bee, ports: { BEE_UPLOADER_API_PORT: 12015 } }] }).resolve('deployment'),
      'bee_container_unsupported',
    );
  });

  it('refuses a deployment between two shapes as target_changed, before capturing its ownership', async () => {
    for (const status of ['DEPLOYING', 'STOPPING', 'REMOVING'] as const) {
      let captures = 0;
      await refusedWith(
        resolver({ current: { ...profile, status }, onCapture: () => captures++ }).resolve('deployment'),
        'target_changed',
      );
      assert.equal(captures, 0, status);
    }
  });

  it('keeps the error of a deployment the capture finds removed or replaced, which is answered as 409', async () => {
    await assert.rejects(
      resolver({
        capture: async () => {
          throw new ChequebookProfileChangedError();
        },
      }).resolve('deployment'),
      (error) => error instanceof ChequebookProfileChangedError,
    );
  });

  it("keeps the cause of the capture's own refusal, and says unavailable for anything else", async () => {
    await refusedWith(
      resolver({
        capture: async () => {
          throw new ChequebookTargetChangedError();
        },
      }).resolve('deployment'),
      'target_changed',
    );
    await refusedWith(
      resolver({
        capture: async () => {
          throw new Error('the journal does not own this node');
        },
      }).resolve('deployment'),
      'unavailable',
    );
  });

  it('refuses no deployment, and a deployment without its own Bee node, as unavailable', async () => {
    await refusedWith(resolver({ current: null }).resolve('deployment'), 'unavailable');
    await refusedWith(
      resolver({ current: { ...profile, components: ['stream-uploader'] } }).resolve('deployment'),
      'unavailable',
    );
  });

  it('uses the configured service port, labels the topology as an operator assertion and carries the ownership', async () => {
    const result = await resolver().resolve('deployment');
    assert.equal(result.url, 'http://bee-host:12005/');
    assert.equal(result.topology, 'operator_asserted_direct');
    assert.equal(result.profileInstanceId, profile.instance_id);
    assert.ok(result.revision);
    assert.deepEqual(result.submissionTarget, captured);
  });

  it('reaches a user@host deployment at the host alone', async () => {
    const result = await resolver({ current: { ...profile, host: 'operator@bee.example.invalid' } }).resolve(
      'deployment',
    );
    assert.equal(result.url, 'http://bee.example.invalid:12005/');
    assert.deepEqual(result.submissionTarget, captured);
  });

  it('preserves hostnames and SSH aliases, removes the SSH username and handles local hostnames', async () => {
    for (const [host, expected] of [
      ['deploy@bee.example.invalid', 'bee.example.invalid'],
      ['bee-alias', 'bee-alias'],
      ['127.0.0.1', '127.0.0.1'],
    ]) {
      const result = await resolver({ current: { ...profile, host } }).resolve('deployment');
      assert.equal(new URL(result.url).hostname, expected);
      assert.equal(new URL(result.url).username, '');
    }
  });

  it('changes its revision for profile generation, host, port, status and stack changes', async () => {
    const baseline = await resolver().resolve('deployment');
    for (const current of [
      { ...profile, updated_at: new Date(1) },
      { ...profile, created_at: new Date(1) },
      { ...profile, instance_id: '22222222-2222-4222-8222-222222222222' },
      { ...profile, host: 'replacement' },
      { ...profile, stack_version_id: 2 },
      { ...profile, status: 'ERROR' as const },
    ]) {
      assert.notEqual((await resolver({ current }).resolve('deployment')).revision, baseline.revision);
    }
    const changed = await resolver({
      containers: [{ ...bee, ports: { BEE_UPLOADER_API_PORT: 12015 } }],
      capture: async () => reserving(12015),
    }).resolve('deployment');
    assert.notEqual(changed.revision, baseline.revision);
  });

  it('refuses known lifecycle transitions and profiles without their own Bee component', async () => {
    for (const current of ['DEPLOYING', 'STOPPING', 'REMOVING']
      .map((status) => ({ ...profile, status }) as Profile)
      .concat([{ ...profile, components: ['stream-uploader'] }])) {
      await assert.rejects(resolver({ current }).resolve('deployment'));
    }
  });
});
