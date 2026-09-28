/**
 * The uploader's token of its own, as the deployment's routes see it: a save of the web2 admin keys counts it for
 * the manager's link address and no other, Rotate the uploader's admin token takes the token out so the next deploy
 * generates a new one, and Test connection says when the admin does not know the deployment's own token yet.
 *
 * Unit test, no database, with the deploy script faked, through the real routes, services and orchestrator over
 * in-memory rows. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';

import { ADMIN_TOKEN_ROTATED_MESSAGE, type StagePushState } from '@streaming-infra-manager/common';
import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { ManagerEvent } from '../../src/domain/EventBus.js';
import type { ProfileKind } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { makeProfile } from '../support/profileFixtures.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('own-admin-token-routes-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { createDeploymentSettingsRouter } = await import('../../src/api/routes/deploymentSettings.js');
const { createAdminLinkTestRouter } = await import('../../src/api/routes/adminLinkTest.js');
const { createAdminTokenRouter } = await import('../../src/api/routes/adminToken.js');
const { AdminLinkTester } = await import('../../src/domain/adminLink/AdminLinkTester.js');
const { AdminTokenRotation } = await import('../../src/domain/adminLink/AdminTokenRotation.js');
const { InMemoryManagerAdminLink } = await import('../support/InMemoryManagerAdminLink.js');
const { DeploymentSettingsService } = await import('../../src/domain/settings/DeploymentSettingsService.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const INSTANCE_ID = '6f1c2b1e-3a4d-4c5e-9f60-7a8b9c0d1e2f';
const ADMIN_URL = 'https://admin.example.com';
const LINK_TOKEN = 'synthetic-link-admin-token-0123456789abcdef';
const COPIED_TOKEN = LINK_TOKEN;
const ELSEWHERE = 'https://elsewhere.example.net';
const REFUSAL =
  'ADMIN_API_URL is set and ADMIN_API_TOKEN is not, and the stream uploader refuses to start that way. Set ADMIN_API_TOKEN, or leave ADMIN_API_URL empty.';

const SAMPLE = `# === Stream Uploader ===
LOG_LEVEL=info
STAMP=

# === Admin mode ===
ADMIN_API_URL=
ADMIN_API_TOKEN=
`;

function writeVersion(token = ''): void {
  writeFileSync(join(root, '.env.sample'), SAMPLE, 'utf8');
  writeFileSync(join(root, '.env'), `ENGINE=srs\nLOG_LEVEL=info\nADMIN_API_URL=\nADMIN_API_TOKEN=${token}\n`, 'utf8');
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(root, 'engines', 'srs', '.env.sample'), '# === SRS Media Server ===\nHLS_FRAGMENT=\n', 'utf8');
}

beforeEach(() => writeVersion());

function sessionFor(username: string): SessionInfo {
  return {
    user: { id: 1, username, isAdmin: false },
    tokenHash: 'not-a-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

interface AppOptions {
  kind?: ProfileKind;
  settings?: Record<string, string>;
  linkToken?: string | null;
  /** What the admin answers the probe. */
  probe?: 'token-accepted' | 'token-refused';
}

async function appFor(options: AppOptions = {}) {
  const stored = makeProfile({
    name: 'stage',
    stamp_id: 'a'.repeat(64),
    instance_id: INSTANCE_ID,
    kind: options.kind ?? 'streamer',
  });
  const harness = orchestratorHarness([stored]);
  await harness.versions.setContract(1, {
    ...structuredClone(ALLOCATION_CONTRACT),
    requiredSecrets: [],
    serviceEnvKeys: {
      'stream-uploader': ['ADMIN_API_TOKEN', 'ADMIN_API_URL', 'LOG_LEVEL', 'STAMP'],
      srs: ['SRS_SRT_PORT'],
    },
  });
  if (options.settings) harness.profiles.stackSettings.set('stage', options.settings);
  const link = new InMemoryManagerAdminLink();
  link.url = ADMIN_URL;
  link.token = options.linkToken === undefined ? LINK_TOKEN : options.linkToken;
  harness.orchestrator.setManagerAdminLink(link);

  const pushes = new Map<string, StagePushState>();
  const probed: string[] = [];
  const tester = new AdminLinkTester(
    link,
    harness.profiles.asRepository(),
    harness.orchestrator,
    async ({ token }) => {
      probed.push(token);
      return options.probe ?? 'token-accepted';
    },
    { lastPush: (name) => pushes.get(name) ?? null },
  );
  const rotation = new AdminTokenRotation(
    harness.profiles.asRepository(),
    harness.orchestrator,
    link,
    harness.containers.asRepository(),
    harness.events,
  );
  const events: ManagerEvent[] = [];
  harness.events.subscribe((event) => void events.push(event));

  const outer = Router();
  const session = sessionFor('operator');
  outer.use((req, _res, next) => {
    req.authSession = session;
    req.user = session.user;
    next();
  });
  outer.use(
    createDeploymentSettingsRouter(
      new DeploymentSettingsService(
        harness.profiles.asRepository(),
        harness.containers.asRepository(),
        harness.orchestrator,
        harness.versions,
        link,
      ),
    ),
  );
  outer.use(createAdminLinkTestRouter(tester));
  outer.use(createAdminTokenRouter(rotation));
  const app = await startRouterTestApp(outer);
  let revision = 0;
  return {
    harness,
    link,
    pushes,
    probed,
    events,
    close: () => app.close(),
    deploy: async () => {
      const index = harness.runner.runs.length;
      await harness.orchestrator.startDeploy(harness.profiles.rows.get('stage')!, undefined);
      harness.runner.finish(index);
      await untilRunning(harness.profiles, 'stage');
    },
    rotate: () => call(app, 'POST', '/profiles/stage/admin-token/rotate', {}),
    test: async () => (await call(app, 'POST', '/profiles/stage/settings/admin-link/test', {})).body,
    save: async (entries: { key: string; value: string | null }[]) => {
      const answer = await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: INSTANCE_ID,
        expectedRevision: revision,
        entries,
      });
      if (answer.status === 200) revision = (answer.body as { revision: number }).revision;
      return answer;
    },
  };
}

function refusalOf(answer: { status: number; body: unknown }): string {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  return (answer.body as { errors: string[] }).errors.join(' ');
}

describe('a save of the web2 admin keys, with the token of its own', () => {
  it("takes the manager's link address with no token, which the next deploy generates", async () => {
    const app = await appFor();
    try {
      assert.equal((await app.save([{ key: 'ADMIN_API_URL', value: `${ADMIN_URL}/v2` }])).status, 200);
    } finally {
      await app.close();
    }
  });

  it('refuses another address with no token, and the link address for a link with no token', async () => {
    const app = await appFor();
    try {
      assert.equal(refusalOf(await app.save([{ key: 'ADMIN_API_URL', value: ELSEWHERE }])), REFUSAL);
    } finally {
      await app.close();
    }
    const unregistered = await appFor({ linkToken: null });
    try {
      assert.equal(refusalOf(await unregistered.save([{ key: 'ADMIN_API_URL', value: ADMIN_URL }])), REFUSAL);
    } finally {
      await unregistered.close();
    }
  });

  it('refuses moving the address away from a token it generated, which goes to the link alone', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL } });
    try {
      await app.deploy();
      assert.ok(app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN, 'the deploy generated one');
      assert.equal(refusalOf(await app.save([{ key: 'ADMIN_API_URL', value: ELSEWHERE }])), REFUSAL);
    } finally {
      await app.close();
    }
  });
});

describe("Rotate the uploader's admin token", () => {
  it('takes the generated token out, and the next deploy generates a new one', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL } });
    const lines: string[] = [];
    const info = mock.method(console, 'info', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    try {
      await app.deploy();
      const first = app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN;
      assert.ok(first);

      const rotated = await app.rotate();
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
      assert.deepEqual(rotated.body, { message: ADMIN_TOKEN_ROTATED_MESSAGE });
      assert.equal(app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN, undefined);
      assert.ok(
        app.events.some((event) => event.type === 'profile.changed' && event.profile.name === 'stage'),
        'the stage publisher is told, so the admin stops taking the old token',
      );
      const next = await app.harness.orchestrator.nextEnvFor(app.harness.profiles.rows.get('stage')!);
      assert.equal(next.env.ADMIN_API_TOKEN ?? '', '', 'no token until the redeploy');

      await app.deploy();
      const second = app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN;
      assert.match(second ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(second, first);
      assert.ok(lines.some((line) => line.includes('operator rotated the web2 admin token of stage')));
      assert.equal(
        lines.some((line) => line.includes(first) || line.includes(second!)),
        false,
        'no token in a log line',
      );
    } finally {
      info.mock.restore();
      await app.close();
    }
  });

  it('takes out a token stored in the settings, copied from the link, with its origin and a new revision', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: COPIED_TOKEN } });
    app.harness.profiles.adminTokenOrigins.set('stage', ADMIN_URL);
    try {
      const before = (await app.harness.profiles.stackSettingsOf('stage'))!.revision;
      assert.equal((await app.rotate()).status, 200);

      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL });
      const after = (await app.harness.profiles.stackSettingsOf('stage'))!;
      assert.equal(after.revision, before + 1);
      assert.equal(after.adminTokenOrigin, null);

      await app.deploy();
      const generated = app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN;
      assert.match(generated ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(generated, COPIED_TOKEN);
    } finally {
      await app.close();
    }
  });

  it('is refused where the next deploy would generate no token of its own, and takes nothing out', async () => {
    const cases: { options: AppOptions; version?: string; says: RegExp }[] = [
      { options: { kind: 'viewer' }, says: /runs no stream uploader/ },
      {
        options: { settings: { ADMIN_API_URL: ELSEWHERE, ADMIN_API_TOKEN: COPIED_TOKEN } },
        says: /another address than the manager's web2 admin link/,
      },
      {
        options: { settings: { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: COPIED_TOKEN }, linkToken: null },
        says: /no web2 admin link with a token/,
      },
      {
        options: { settings: { ADMIN_API_URL: ADMIN_URL } },
        version: COPIED_TOKEN,
        says: /version sets ADMIN_API_TOKEN in its env files/,
      },
    ];
    for (const { options, version, says } of cases) {
      writeVersion(version ?? '');
      const app = await appFor(options);
      try {
        const refused = await app.rotate();
        assert.match(refusalOf(refused), says);
        assert.equal(JSON.stringify(refused.body).includes(COPIED_TOKEN), false);
        assert.equal(
          (await app.harness.profiles.stackSettingsForDeploy('stage')).ADMIN_API_TOKEN,
          options.settings?.ADMIN_API_TOKEN,
        );
      } finally {
        await app.close();
      }
    }
  });

  it('is refused while a deploy is under way', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL } });
    try {
      app.harness.profiles.write('stage', { status: 'DEPLOYING' });
      const refused = await app.rotate();
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
    } finally {
      await app.close();
    }
  });
});

describe("Test connection with the deployment's own token", () => {
  it('says the admin does not know it yet while no push of the stage was stored', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL }, probe: 'token-refused' });
    try {
      await app.deploy();
      assert.deepEqual(await app.test(), { outcome: 'token-not-registered' });

      app.pushes.set('stage', { outcome: 'refused-token', at: new Date().toISOString() });
      assert.deepEqual(await app.test(), { outcome: 'token-not-registered' });

      app.pushes.set('stage', { outcome: 'stored', at: new Date().toISOString() });
      assert.deepEqual(await app.test(), { outcome: 'token-refused' });
    } finally {
      await app.close();
    }
  });

  it("asks with the deployment's own token and says a refusal of the shared one as it is", async () => {
    const app = await appFor({
      settings: { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: COPIED_TOKEN },
      probe: 'token-refused',
    });
    try {
      assert.deepEqual(await app.test(), { outcome: 'token-refused' });
      assert.deepEqual(app.probed, [COPIED_TOKEN]);
    } finally {
      await app.close();
    }
  });

  it('takes an accepted own token as it is', async () => {
    const app = await appFor({ settings: { ADMIN_API_URL: ADMIN_URL } });
    try {
      await app.deploy();
      assert.deepEqual(await app.test(), { outcome: 'token-accepted' });
      assert.deepEqual(app.probed, [app.harness.profiles.secrets.get('stage')?.ADMIN_API_TOKEN]);
    } finally {
      await app.close();
    }
  });
});
