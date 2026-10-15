import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfiguredBeeTargetResolver } from '../../src/domain/chequebook/ConfiguredBeeTargetResolver.js';
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
function resolver(
  options: {
    current?: Profile | null;
    containers?: { service: string; ports: Record<string, number> }[];
    capture?: () => Promise<typeof captured>;
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
    options.capture ?? (async () => captured),
  );
}

describe('configured Bee target locator', () => {
  it('requires a deployment, exactly one saved Bee API port and a captured ownership', async () => {
    for (const options of [
      { current: null },
      { containers: [] },
      { containers: [bee, bee] },
      { containers: [{ ...bee, ports: {} }] },
      ...[0, 65536, 1.5, NaN].map((port) => ({
        containers: [{ ...bee, ports: { BEE_UPLOADER_API_PORT: port } }],
      })),
      {
        capture: async () => {
          throw new Error('the journal does not own this node');
        },
      },
    ]) {
      await assert.rejects(
        resolver(options).resolve('deployment'),
        (error) => error instanceof Error && error.name === 'ChequebookPreparationError',
      );
    }
  });

  it('uses the configured service port, labels the topology as an operator assertion and carries the ownership', async () => {
    const result = await resolver().resolve('deployment');
    assert.equal(result.url, 'http://bee-host:12005/');
    assert.equal(result.topology, 'operator_asserted_direct');
    assert.equal(result.profileInstanceId, profile.instance_id);
    assert.ok(result.revision);
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
