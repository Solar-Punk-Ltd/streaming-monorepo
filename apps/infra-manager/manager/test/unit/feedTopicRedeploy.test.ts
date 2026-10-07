/**
 * A feed topic change, and nothing else, redeploys the viewer's client.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The client bakes its topic into its bundle when its image is built, beside
 * the owner (VITE_APP_RAW_TOPIC and VITE_APP_OWNER, deploy/Dockerfile.client
 * in the stack), so a topic stored without a redeploy would change what the
 * pages say and not what the player follows. Where the manager decides that
 * an edit redeploys is ProfileService: a deployment's edit claims and deploys
 * every service the deployment runs, and a group's edit every member, whatever
 * field changed. These pin the topic inside that decision, and that clearing
 * it deploys a row with none, which deploy.sh reads as the version's own.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const TOPIC = 'brand.catalog_1';
const VIEWER_SERVICES = ['client', 'bee-gateway'];

const viewer = (over: Partial<Profile> = {}): Profile =>
  makeProfile({
    name: 'watch1',
    kind: 'viewer',
    components: VIEWER_SERVICES,
    feed_owner: OWNER,
    notes: 'as it was',
    ...over,
  });

describe('a deployment edit that changes only the topic', () => {
  it('redeploys every service the viewer runs, its client among them, with the new topic', async () => {
    const harness = profileServiceHarness([viewer()]);

    // What the Edit drawer sends: every field as it is, and the topic typed.
    await harness.service.update('watch1', { notes: 'as it was', feed_owner: OWNER, feed_topic: TOPIC });

    assert.deepEqual(harness.orchestrator.deploys, [{ profileName: 'watch1', services: VIEWER_SERVICES }]);
    assert.equal(harness.orchestrator.deployedRows[0]?.feed_topic, TOPIC);
    assert.equal(harness.profiles.rows.get('watch1')?.feed_topic, TOPIC);
  });

  it('redeploys the client with no topic when the edit clears it, which is the version’s own', async () => {
    const harness = profileServiceHarness([viewer({ feed_topic: TOPIC })]);

    await harness.service.update('watch1', { notes: 'as it was', feed_owner: OWNER, feed_topic: null });

    assert.deepEqual(harness.orchestrator.deploys, [{ profileName: 'watch1', services: VIEWER_SERVICES }]);
    assert.equal(harness.orchestrator.deployedRows[0]?.feed_topic, null);
    assert.equal(harness.profiles.rows.get('watch1')?.feed_topic, null);
  });

  /**
   * The PUT replaces every editable field, so a body that leaves the topic out
   * clears it too. That is why the drawer always sends the topic it holds,
   * and before the drawer had the field every save from it dropped a topic set
   * through the API.
   */
  it('clears the topic as well when the body leaves it out', async () => {
    const harness = profileServiceHarness([viewer({ feed_topic: TOPIC })]);

    await harness.service.update('watch1', { notes: 'edited', feed_owner: OWNER });

    assert.equal(harness.orchestrator.deployedRows[0]?.feed_topic, null);
  });
});

describe('a group edit that changes only the topic', () => {
  function withGroup(topic: string | null) {
    const harness = profileServiceHarness([
      viewer({ name: 'watchers-profile-1', group_id: 1, feed_topic: topic }),
      viewer({ name: 'watchers-profile-2', group_id: 1, feed_topic: topic }),
    ]);
    harness.groups.groups.push({ id: 1, name: 'watchers', size: 2, kind: 'standard', created_at: new Date(0) });
    return harness;
  }

  const topicsOf = (rows: readonly Profile[]) => rows.map((row) => [row.name, row.feed_topic]);

  it('redeploys every member, each client with the new topic', async () => {
    const harness = withGroup(null);

    await harness.service.updateGroupConfig(1, { feed_topic: TOPIC });

    assert.deepEqual(harness.orchestrator.deploys, [
      { profileName: 'watchers-profile-1', services: VIEWER_SERVICES },
      { profileName: 'watchers-profile-2', services: VIEWER_SERVICES },
    ]);
    assert.deepEqual(topicsOf(harness.orchestrator.deployedRows), [
      ['watchers-profile-1', TOPIC],
      ['watchers-profile-2', TOPIC],
    ]);
  });

  it('puts every member back on the version’s topic when the edit sends null', async () => {
    const harness = withGroup(TOPIC);

    await harness.service.updateGroupConfig(1, { feed_topic: null });

    assert.deepEqual(topicsOf(harness.orchestrator.deployedRows), [
      ['watchers-profile-1', null],
      ['watchers-profile-2', null],
    ]);
  });

  it('keeps every member’s topic when the edit says nothing about it', async () => {
    const harness = withGroup(TOPIC);

    await harness.service.updateGroupConfig(1, { notes: 'edited' });

    assert.deepEqual(topicsOf(harness.orchestrator.deployedRows), [
      ['watchers-profile-1', TOPIC],
      ['watchers-profile-2', TOPIC],
    ]);
  });
});
