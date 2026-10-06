/**
 * A feed topic outside the stack's shape, refused at every route that takes one.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Four routes carry `feed_topic`: a deployment's create and its edit, a
 * group's create and its shared settings edit. The schemas have tests of their
 * own. What is asked here is what an operator's request gets back: a 400 in the
 * shape every validation refusal of these routes has, with the one sentence the
 * form shows, and nothing handed to the service, which would store the topic
 * and start a deploy the stack's script refuses on the host.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { FEED_TOPIC_MESSAGE } from '@streaming-infra-manager/common';

import { createGroupsRouter } from '../../src/api/routes/groups.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';
import type { UploaderHealthService } from '../../src/domain/UploaderHealthService.js';
import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';

const apps: RouterTestApp[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

/** What each route handler handed the service, and nothing else. */
class RecordingService {
  readonly calls: Record<string, unknown>[] = [];

  asService(): ProfileService {
    return this as unknown as ProfileService;
  }

  async create(input: Record<string, unknown>): Promise<Profile> {
    this.calls.push(input);
    return makeProfile({ name: String(input.name) });
  }

  async update(name: string, input: Record<string, unknown>): Promise<Profile> {
    this.calls.push(input);
    return makeProfile({ name });
  }

  async createGroup(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push(input);
    return { group: { id: 1, name: input.group_name }, profiles: [] };
  }

  async updateGroupConfig(_id: number, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push(input);
    return { group: { id: 1, name: 'watchers' }, profiles: [] };
  }
}

const noHealth = {} as unknown as UploaderHealthService;

/** One route that takes a topic, with the least else its body needs. */
interface TopicRoute {
  label: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const ROUTES: readonly TopicRoute[] = [
  { label: 'POST /profiles', method: 'POST', path: '/profiles', body: { name: 'watch1', kind: 'viewer' } },
  { label: 'PUT /profiles/:name', method: 'PUT', path: '/profiles/watch1', body: {} },
  {
    label: 'POST /groups',
    method: 'POST',
    path: '/groups',
    body: { group_name: 'watchers', size: 2, kind: 'viewer' },
  },
  { label: 'PATCH /groups/:id/config', method: 'PATCH', path: '/groups/1/config', body: {} },
];

/** Both routers as `api/server.ts` mounts them, over one recording service. */
async function opened(service: RecordingService): Promise<{ profiles: RouterTestApp; groups: RouterTestApp }> {
  const profiles = await startRouterTestApp(createProfilesRouter(service.asService(), noHealth, false), '/profiles');
  const groups = await startRouterTestApp(createGroupsRouter(service.asService(), false), '/groups');
  apps.push(profiles, groups);
  return { profiles, groups };
}

async function send(route: TopicRoute, topic: unknown, service: RecordingService) {
  const { profiles, groups } = await opened(service);
  const app = route.path.startsWith('/groups') ? groups : profiles;
  const body = topic === undefined ? route.body : { ...route.body, feed_topic: topic };
  return call(app, route.method, route.path, body);
}

describe('a feed topic outside the stack’s shape', () => {
  for (const route of ROUTES) {
    it(`is a 400 on ${route.label}, in one sentence, and reaches no service`, async () => {
      const service = new RecordingService();

      const res = await send(route, 'my stream', service);

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        error: 'validation_error',
        errors: [`feed_topic ${FEED_TOPIC_MESSAGE}`],
      });
      assert.deepEqual(service.calls, []);
    });
  }
});

describe('a topic the body names, or does not', () => {
  for (const route of ROUTES) {
    it(`reaches the service as sent on ${route.label}`, async () => {
      const service = new RecordingService();

      const res = await send(route, 'brand.catalog_1', service);

      assert.equal(res.status, 202);
      assert.equal(service.calls[0]?.feed_topic, 'brand.catalog_1');
    });

    it(`is no topic at all on ${route.label} when it is null or absent`, async () => {
      const cleared = new RecordingService();
      const absent = new RecordingService();

      const nullRes = await send(route, null, cleared);
      const absentRes = await send(route, undefined, absent);

      assert.equal(nullRes.status, 202);
      assert.equal(absentRes.status, 202);
      assert.equal(cleared.calls[0]?.feed_topic ?? null, null);
      assert.equal(absent.calls[0]?.feed_topic, undefined);
    });
  }

  /**
   * The two edits read null differently from absent, and a form that empties
   * the field relies on it: null is the operator going back to the version's
   * topic, absent on the group edit is every member keeping its own.
   */
  it('hands an explicit null on to both edits, where it clears the topic', async () => {
    for (const route of ROUTES.filter(({ method }) => method === 'PUT' || method === 'PATCH')) {
      const service = new RecordingService();

      await send(route, null, service);

      assert.equal(service.calls[0]?.feed_topic, null, route.label);
    }
  });
});
