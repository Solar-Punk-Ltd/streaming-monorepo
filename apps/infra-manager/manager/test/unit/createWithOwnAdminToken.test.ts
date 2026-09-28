/**
 * A new deployment, or a new group, linked to the manager's web2 admin, through
 * the create routes, the real service and in-memory rows.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/. No
 * create copies the manager's stored token in any more: an uploader given the
 * link's address gets a token of its own at its first deploy, which
 * `ownAdminToken.test.ts` proves. This proves the create stores the address
 * alone, counts that token for the link's address and no other when it holds
 * the web2 admin rule, takes the retired `use_manager_admin_token` and ignores
 * it, and gives a create for an uploader that names neither key the manager's
 * own address.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

const root = throwawayRoot('create-with-own-admin-token-');
process.env.SHLS_ROOT = root;

const { createGroupsRouter } = await import('../../src/api/routes/groups.js');
const { createProfilesRouter } = await import('../../src/api/routes/profiles.js');
const { profileServiceHarness } = await import('../support/profileServiceHarness.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const ADMIN_URL = 'https://admin.example.com';
const STORED_TOKEN = 'synthetic-stored-admin-token-fedcba9876543210';
const TYPED_TOKEN = 'synthetic-typed-admin-token-0123456789abcdef';

const SAMPLE_WITH_ADMIN =
  '# === Stream Uploader ===\nLOG_LEVEL=info\nSTAMP=\n\n# === Admin mode ===\nADMIN_API_URL=\nADMIN_API_TOKEN=\n';

function writeVersion(sample = SAMPLE_WITH_ADMIN): void {
  writeFileSync(join(root, '.env.sample'), sample, 'utf8');
  writeFileSync(join(root, '.env'), 'LOG_LEVEL=info\nADMIN_API_URL=\nADMIN_API_TOKEN=\n', 'utf8');
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(root, 'engines', 'srs', '.env.sample'), '# === SRS Media Server ===\nHLS_FRAGMENT=\n', 'utf8');
}

beforeEach(() => writeVersion());

async function appFor(options: { storedToken?: string | null } = {}) {
  const harness = profileServiceHarness();
  harness.profiles.managerAdminLink.url = ADMIN_URL;
  harness.profiles.managerAdminLink.token = options.storedToken === undefined ? STORED_TOKEN : options.storedToken;
  const profiles = await startRouterTestApp(
    createProfilesRouter(harness.service, uploaderHealthStub(), false),
    '/profiles',
  );
  const groups = await startRouterTestApp(createGroupsRouter(harness.service, false), '/groups');
  return {
    harness,
    create: (body: Record<string, unknown>) =>
      call(profiles, 'POST', '/profiles', { name: 'stage', kind: 'streamer', ...body }),
    createGroup: (body: Record<string, unknown>) =>
      call(groups, 'POST', '/groups', { group_name: 'fleet', size: 2, kind: 'streamer', ...body }),
    close: async () => {
      await profiles.close();
      await groups.close();
    },
  };
}

const LINKED = { stack_settings: [{ key: 'ADMIN_API_URL', value: ADMIN_URL }] };

/** The rule's own sentence, which names both keys and no value. */
const NO_TOKEN = /ADMIN_API_URL is set and ADMIN_API_TOKEN is not/;

describe("a create for an uploader at the manager's web2 admin address", () => {
  it('stores the address alone, since the first deploy generates a token of its own', async () => {
    const app = await appFor();
    try {
      const created = await app.create(LINKED);

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL });
      assert.equal(app.harness.profiles.adminTokenOrigins.has('stage'), false);
      assert.equal(JSON.stringify(created.body).includes(STORED_TOKEN), false);
    } finally {
      await app.close();
    }
  });

  it('stores the address alone for every member of a new group', async () => {
    const app = await appFor();
    try {
      const created = await app.createGroup(LINKED);

      assert.equal(created.status, 202, JSON.stringify(created.body));
      for (const name of ['fleet-profile-1', 'fleet-profile-2']) {
        assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy(name), { ADMIN_API_URL: ADMIN_URL }, name);
      }
    } finally {
      await app.close();
    }
  });

  it("takes an address on the link's origin with another path", async () => {
    const app = await appFor();
    try {
      const created = await app.create({ stack_settings: [{ key: 'ADMIN_API_URL', value: `${ADMIN_URL}/v2` }] });
      assert.equal(created.status, 202, JSON.stringify(created.body));
    } finally {
      await app.close();
    }
  });

  it('is refused for an address on another origin with no token, which no deploy would give it', async () => {
    const app = await appFor();
    try {
      for (const elsewhere of [
        'https://elsewhere.example.net',
        'http://admin.example.com',
        'https://admin.example.com:8443',
      ]) {
        const refused = await app.create({ stack_settings: [{ key: 'ADMIN_API_URL', value: elsewhere }] });

        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.match(JSON.stringify(refused.body), NO_TOKEN);
      }
      const group = await app.createGroup({
        stack_settings: [{ key: 'ADMIN_API_URL', value: 'https://elsewhere.example.net' }],
      });
      assert.equal(group.status, 400, JSON.stringify(group.body));
      assert.equal(app.harness.profiles.rows.size, 0);
      assert.equal(app.harness.orchestrator.deploys.length, 0);
    } finally {
      await app.close();
    }
  });

  it('is refused at the address when the link stores no token to register one of its own with', async () => {
    const app = await appFor({ storedToken: null });
    try {
      const refused = await app.create(LINKED);

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), NO_TOKEN);
      assert.equal(app.harness.profiles.rows.has('stage'), false);
    } finally {
      await app.close();
    }
  });

  it('is refused for a deployment that runs no uploader, which gets no token of its own', async () => {
    const app = await appFor();
    try {
      const refused = await app.create({ ...LINKED, name: 'watch', kind: 'viewer' });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), NO_TOKEN);
    } finally {
      await app.close();
    }
  });

  it('stores a token typed beside the address, for the origin of that address', async () => {
    const app = await appFor();
    try {
      const created = await app.create({
        stack_settings: [
          { key: 'ADMIN_API_URL', value: 'https://elsewhere.example.net' },
          { key: 'ADMIN_API_TOKEN', value: TYPED_TOKEN },
        ],
      });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.equal((await app.harness.profiles.stackSettingsForDeploy('stage')).ADMIN_API_TOKEN, TYPED_TOKEN);
      assert.equal(app.harness.profiles.adminTokenOrigins.get('stage'), 'https://elsewhere.example.net');
      assert.equal(JSON.stringify(created.body).includes(TYPED_TOKEN), false);
    } finally {
      await app.close();
    }
  });
});

describe('the retired use_manager_admin_token', () => {
  it('is taken and ignored: nothing is copied, and the create is judged as one that sends no token', async () => {
    const app = await appFor();
    try {
      const created = await app.create({ ...LINKED, use_manager_admin_token: true });
      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL });

      const group = await app.createGroup({ ...LINKED, use_manager_admin_token: true });
      assert.equal(group.status, 202, JSON.stringify(group.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('fleet-profile-1'), {
        ADMIN_API_URL: ADMIN_URL,
      });
    } finally {
      await app.close();
    }
  });

  it('lets a typed token stand beside it', async () => {
    const app = await appFor();
    try {
      const created = await app.create({
        stack_settings: [
          { key: 'ADMIN_API_URL', value: ADMIN_URL },
          { key: 'ADMIN_API_TOKEN', value: TYPED_TOKEN },
        ],
        use_manager_admin_token: true,
      });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.equal((await app.harness.profiles.stackSettingsForDeploy('stage')).ADMIN_API_TOKEN, TYPED_TOKEN);
    } finally {
      await app.close();
    }
  });

  it('with no key named, starts the deployment at the manager address as a create without it does', async () => {
    const app = await appFor();
    try {
      const created = await app.create({ use_manager_admin_token: true });
      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL });
    } finally {
      await app.close();
    }
  });

  it('is still refused when it is not true or false', async () => {
    const app = await appFor();
    try {
      const refused = await app.create({ ...LINKED, use_manager_admin_token: 'please' });

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(app.harness.profiles.rows.has('stage'), false);
    } finally {
      await app.close();
    }
  });
});

describe('a scripted create for an uploader that names neither web2 admin key', () => {
  it("starts linked at the manager's own address, with no token stored", async () => {
    const app = await appFor();
    try {
      const created = await app.create({});

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL });
      assert.equal(JSON.stringify(created.body).includes(STORED_TOKEN), false);
    } finally {
      await app.close();
    }
  });

  it("starts every member of a new group at the manager's own address", async () => {
    const app = await appFor();
    try {
      const created = await app.createGroup({});

      assert.equal(created.status, 202, JSON.stringify(created.body));
      for (const name of ['fleet-profile-1', 'fleet-profile-2']) {
        assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy(name), { ADMIN_API_URL: ADMIN_URL }, name);
      }
    } finally {
      await app.close();
    }
  });

  it('adds the address beside the other settings a create names', async () => {
    const app = await appFor();
    try {
      await app.create({ stack_settings: [{ key: 'LOG_LEVEL', value: 'debug' }] });
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), {
        LOG_LEVEL: 'debug',
        ADMIN_API_URL: ADMIN_URL,
      });
    } finally {
      await app.close();
    }
  });

  it('starts standalone when the manager stores no token, since no token of its own could be registered', async () => {
    const app = await appFor({ storedToken: null });
    try {
      const created = await app.create({});

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), {});
    } finally {
      await app.close();
    }
  });

  it('starts standalone for a deployment that runs no uploader, and for a version that takes no token', async () => {
    const app = await appFor();
    try {
      const viewer = await app.create({ name: 'watch', kind: 'viewer' });
      assert.equal(viewer.status, 202, JSON.stringify(viewer.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('watch'), {});

      writeVersion('# === Stream Uploader ===\nLOG_LEVEL=info\nSTAMP=\nADMIN_API_URL=\n');
      const noToken = await app.create({});
      assert.equal(noToken.status, 202, JSON.stringify(noToken.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), {});
    } finally {
      await app.close();
    }
  });
});
