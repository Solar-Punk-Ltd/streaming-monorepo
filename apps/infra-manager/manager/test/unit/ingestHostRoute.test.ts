/**
 * Saving a deployment's public ingest address, over HTTP.
 *
 * Unit test: the profiles router on a random port, with the profile
 * repository in memory and the orchestrator standing in. `pnpm test` in
 * manager/.
 *
 * The address is what encoders dial and the stage record carries. No container
 * reads it, so saving it takes no claim and starts no deploy, and the change
 * event it publishes is what pushes the stage record again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { ManagerEvent } from '../../src/domain/EventBus.js';
import { profileRow, profileServiceHarness, type ProfileServiceHarness } from '../support/profileServiceHarness.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

async function withApp(run: (app: RouterTestApp, harness: ProfileServiceHarness) => Promise<void>): Promise<void> {
  const harness = profileServiceHarness([profileRow({ status: 'RUNNING' })]);
  const app = await startRouterTestApp(createProfilesRouter(harness.service, uploaderHealthStub(), false), '/profiles');
  try {
    await run(app, harness);
  } finally {
    await app.close();
  }
}

describe('PATCH /profiles/:name/ingest-host', () => {
  it('saves the address and nothing else, and announces the change', () =>
    withApp(async (app, harness) => {
      const seen: ManagerEvent[] = [];
      harness.events.subscribe((event) => seen.push(event));

      const res = await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: 'ingest.example.org' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((res.body as { ingest_host: string }).ingest_host, 'ingest.example.org');
      assert.equal(harness.profiles.rows.get('stream1')?.ingest_host, 'ingest.example.org');
      assert.deepEqual(harness.orchestrator.reserved, [], 'no claim was taken');
      assert.deepEqual(harness.orchestrator.deploys, [], 'nothing was deployed');
      assert.deepEqual(
        seen.map((event) => event.type),
        ['profile.changed'],
      );
    }));

  it('takes an IPv4 address and a bracketed IPv6 one', () =>
    withApp(async (app) => {
      for (const host of ['192.0.2.10', '[2001:db8::1]']) {
        const res = await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: host });
        assert.equal(res.status, 200, `${host}: ${JSON.stringify(res.body)}`);
      }
    }));

  it('clears the address with null or an empty one', () =>
    withApp(async (app, harness) => {
      await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: 'ingest.example.org' });
      for (const cleared of [null, '']) {
        await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: 'ingest.example.org' });
        const res = await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: cleared });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(harness.profiles.rows.get('stream1')?.ingest_host, null);
      }
    }));

  it('refuses a scheme, a port or a path, without repeating the value, and changes nothing', () =>
    withApp(async (app, harness) => {
      for (const bad of [
        'srt://ingest.example.org',
        'ingest.example.org:9000',
        'ingest.example.org/live',
        '2001:db8::1',
      ]) {
        const res = await call(app, 'PATCH', '/profiles/stream1/ingest-host', { ingest_host: bad });
        assert.equal(res.status, 400, bad);
        assert.doesNotMatch(JSON.stringify(res.body), /ingest\.example\.org|2001:db8/);
      }
      assert.equal(harness.profiles.rows.get('stream1')?.ingest_host, null);
    }));

  it('refuses a body without the field, and answers 404 for a deployment that is not there', () =>
    withApp(async (app) => {
      assert.equal((await call(app, 'PATCH', '/profiles/stream1/ingest-host', {})).status, 400);
      assert.equal(
        (await call(app, 'PATCH', '/profiles/nobody/ingest-host', { ingest_host: 'ingest.example.org' })).status,
        404,
      );
    }));
});
