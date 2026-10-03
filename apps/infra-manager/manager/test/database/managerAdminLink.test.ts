/**
 * The manager's own web2 admin link, migration 041's single-row table, and
 * migration 042's record of where a deployment's token goes, against a real
 * PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with DEPLOYMENT_SETTINGS_TEST_PG_PORT set.
 *
 * What only the database can show: that the table holds one row and never a
 * second, that a read never selects the token, that a save lands only at the
 * revision it read, and that the rules the columns carry refuse a token with
 * no address even from a write that skipped the service. That no insert
 * copies the stored token into a new deployment any more, and that Rotate the
 * uploader's admin token takes both kinds of token out in one statement. And
 * that migration 042 records the origin a deployment's own token is for,
 * which a save moves only when it stores or takes out the token.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { STANDARD_GROUP_KIND } from '@streaming-infra-manager/common';

import { AdminTokenRotation } from '../../src/domain/adminLink/AdminTokenRotation.js';
import { ManagerAdminLinkRepository } from '../../src/domain/adminLink/ManagerAdminLinkRepository.js';
import type { NextDeployEnv } from '../../src/domain/DeploymentOrchestrator.js';
import { ProfileBusyError } from '../../src/domain/errors/index.js';
import { DeploymentGroupRepository, type SharedProfileParams } from '../../src/domain/DeploymentGroupRepository.js';
import { type InitialStackSettings, ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.DEPLOYMENT_SETTINGS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'deployment_settings_test',
  connectionTimeoutMillis: 10000,
};

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';

describe(
  "the manager's web2 admin link table, in isolated PostgreSQL",
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let link: ManagerAdminLinkRepository;

    async function migrate(target: Pool): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    beforeEach(async () => {
      schema = `admin_link_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      link = new ManagerAdminLinkRepository(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('starts with its one row and no default', async () => {
      const rows = await pool.query('SELECT url, token, revision FROM manager_admin_link');

      assert.deepEqual(rows.rows, [{ url: null, token: null, revision: 0 }]);
      assert.deepEqual(await link.read(), { url: null, tokenStored: false, revision: 0 });
      assert.equal((await link.storedLink()).token, null);
    });

    it('refuses a second row', async () => {
      await assert.rejects(pool.query('INSERT INTO manager_admin_link DEFAULT VALUES'), /duplicate key|unique/i);
      await assert.rejects(
        pool.query('INSERT INTO manager_admin_link (singleton) VALUES (false)'),
        /check constraint/i,
      );
    });

    it('stores an address and a token, and answers only that a token is stored', async () => {
      const saved = await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      assert.deepEqual(saved, { url: ADMIN_URL, tokenStored: true, revision: 1 });
      assert.deepEqual(await link.read(), saved);
      assert.doesNotMatch(JSON.stringify(await link.read()), new RegExp(TOKEN));
      assert.equal((await link.storedLink()).token, TOKEN);
      const row = await pool.query('SELECT updated_by FROM manager_admin_link');
      assert.equal(row.rows[0].updated_by, 'operator');
    });

    it('keeps the stored token when a write leaves it out, and clears it on null', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      assert.deepEqual(await link.write({ url: 'https://admin2.example.com' }, 1, 'operator'), {
        url: 'https://admin2.example.com',
        tokenStored: true,
        revision: 2,
      });
      assert.equal((await link.storedLink()).token, TOKEN);
      assert.deepEqual(await link.write({ url: ADMIN_URL, token: null }, 2, 'operator'), {
        url: ADMIN_URL,
        tokenStored: false,
        revision: 3,
      });
      assert.equal((await link.storedLink()).token, null);
    });

    it('takes the token out with the address, which leaves no default', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

      assert.deepEqual(await link.write({ url: null }, 1, 'operator'), { url: null, tokenStored: false, revision: 2 });
      assert.equal((await link.storedLink()).token, null);
    });

    it('writes nothing at a revision another write has moved past', async () => {
      await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'first');

      assert.equal(await link.write({ url: 'https://admin2.example.com', token: null }, 0, 'second'), null);
      assert.deepEqual(await link.read(), { url: ADMIN_URL, tokenStored: true, revision: 1 });
      assert.equal((await link.storedLink()).token, TOKEN);
    });

    it('refuses a token with no address, and an empty address, from a write that skipped the service', async () => {
      await assert.rejects(pool.query(`UPDATE manager_admin_link SET token = $1`, [TOKEN]), /check constraint/i);
      await assert.rejects(pool.query(`UPDATE manager_admin_link SET url = ''`), /check constraint/i);
    });

    describe("a new deployment and the manager's stored token", () => {
      /** The bundled version the migrations insert first, on a daemon of its own with no ports to reserve. */
      const PLACEMENT = { stackVersionId: 1, slotCap: 99, daemonId: 'synthetic-daemon', table: [] };
      const LINKED: InitialStackSettings = { plain: { ADMIN_API_URL: ADMIN_URL }, secret: {} };

      async function secretsOf(name: string): Promise<unknown> {
        const row = await pool.query('SELECT stack_settings_secret, stack_secrets FROM profiles WHERE name = $1', [
          name,
        ]);
        return row.rows[0];
      }

      function groupParams(stackSettings: InitialStackSettings): SharedProfileParams {
        return {
          kind: 'streamer',
          notes: null,
          components: null,
          host: null,
          feed_owner: null,
          feed_topic: null,
          private_key: null,
          public_key: null,
          stamp_id: null,
          srt_passphrase: null,
          node_mode: null,
          rpc_endpoint_source: 'stack',
          rpc_endpoint: null,
          stack_version_id: 1,
          engine_settings: {},
          stack_settings: stackSettings,
          slot_cap: 99,
          daemon_id: 'synthetic-daemon',
          table: [],
        };
      }

      it('is copied into no deployment at the insert: its first deploy generates a token of its own', async () => {
        await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');

        await new ProfileRepository(pool).insertWithFreeSlot(
          'linked',
          'streamer',
          'DEPLOYING',
          {},
          PLACEMENT,
          {},
          LINKED,
        );
        await new DeploymentGroupRepository(pool).createGroupWithMembers(
          'fleet',
          STANDARD_GROUP_KIND,
          [{ name: 'fleet-1' }, { name: 'fleet-2' }],
          groupParams(LINKED),
        );

        for (const name of ['linked', 'fleet-1', 'fleet-2']) {
          assert.deepEqual(await secretsOf(name), { stack_settings_secret: {}, stack_secrets: {} }, name);
          assert.deepEqual(await new ProfileRepository(pool).stackSettingsForDeploy(name), {
            ADMIN_API_URL: ADMIN_URL,
          });
        }
      });
    });

    describe("Rotate the uploader's admin token", () => {
      const PLACEMENT = { stackVersionId: 1, slotCap: 99, daemonId: 'synthetic-daemon', table: [] };
      const OTHER = 'synthetic-other-generated-token-0000000000000000';

      async function rowOf(name: string) {
        const row = await pool.query(
          `SELECT stack_secrets, stack_settings_secret, admin_token_origin, settings_revision
             FROM profiles WHERE name = $1`,
          [name],
        );
        return row.rows[0];
      }

      it('takes out the generated token and a stored one, with its origin, and moves the revision', async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'copied',
          'streamer',
          'STOPPED',
          {},
          PLACEMENT,
          {},
          {
            plain: { ADMIN_API_URL: ADMIN_URL },
            secret: { ADMIN_API_TOKEN: TOKEN, SRT_PASSPHRASE_EXTRA: 'kept-secret-value-000' },
            adminTokenOrigin: ADMIN_URL,
          },
        );
        assert.ok(row);
        await profiles.storeStackSecrets('copied', { ADMIN_API_TOKEN: OTHER, API_AUTH_TOKEN: 'b'.repeat(64) });

        const cleared = await profiles.clearAdminToken('copied', row.instance_id);

        assert.equal(cleared?.name, 'copied');
        assert.doesNotMatch(JSON.stringify(cleared), new RegExp(`${TOKEN}|${OTHER}`));
        assert.deepEqual(await rowOf('copied'), {
          stack_secrets: { API_AUTH_TOKEN: 'b'.repeat(64) },
          stack_settings_secret: { SRT_PASSPHRASE_EXTRA: 'kept-secret-value-000' },
          admin_token_origin: null,
          settings_revision: 1,
        });
      });

      it('moves no revision and keeps the origin when only a generated token was there', async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'own',
          'streamer',
          'STOPPED',
          {},
          PLACEMENT,
          {},
          { plain: { ADMIN_API_URL: ADMIN_URL }, secret: {} },
        );
        assert.ok(row);
        await profiles.storeStackSecrets('own', { ADMIN_API_TOKEN: OTHER });

        assert.ok(await profiles.clearAdminToken('own', row.instance_id));

        assert.deepEqual(await rowOf('own'), {
          stack_secrets: {},
          stack_settings_secret: {},
          admin_token_origin: null,
          settings_revision: 0,
        });
      });

      it('changes nothing for another instance of the name', async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'moved',
          'streamer',
          'STOPPED',
          {},
          PLACEMENT,
          {},
          { plain: {}, secret: {} },
        );
        assert.ok(row);
        await profiles.storeStackSecrets('moved', { ADMIN_API_TOKEN: OTHER });

        assert.equal(await profiles.clearAdminToken('moved', '00000000-0000-4000-8000-000000000000'), null);
        assert.deepEqual((await rowOf('moved')).stack_secrets, { ADMIN_API_TOKEN: OTHER });
      });

      it('takes nothing out of a deployment in the middle of a deploy, stop or removal', async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'busy',
          'streamer',
          'STOPPED',
          {},
          PLACEMENT,
          {},
          { plain: { ADMIN_API_URL: ADMIN_URL }, secret: { ADMIN_API_TOKEN: TOKEN }, adminTokenOrigin: ADMIN_URL },
        );
        assert.ok(row);
        await profiles.storeStackSecrets('busy', { ADMIN_API_TOKEN: OTHER });

        for (const status of ['DEPLOYING', 'STOPPING', 'REMOVING']) {
          await pool.query('UPDATE profiles SET status = $2 WHERE name = $1', ['busy', status]);
          assert.equal(await profiles.clearAdminToken('busy', row.instance_id), null, status);
        }
        assert.deepEqual(await rowOf('busy'), {
          stack_secrets: { ADMIN_API_TOKEN: OTHER },
          stack_settings_secret: { ADMIN_API_TOKEN: TOKEN },
          admin_token_origin: ADMIN_URL,
          settings_revision: 0,
        });
      });

      it("is refused as busy when a deploy starts between the rotation's read and its clear", async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'raced',
          'streamer',
          'RUNNING',
          {},
          PLACEMENT,
          {},
          { plain: { ADMIN_API_URL: ADMIN_URL }, secret: {} },
        );
        assert.ok(row);
        await profiles.storeStackSecrets('raced', { ADMIN_API_TOKEN: OTHER });
        await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');
        const root = await mkdtemp(join(tmpdir(), 'rotate-race-'));

        const rotation = new AdminTokenRotation(
          profiles,
          {
            // The rotation reads the row, then the next deploy's environment: a deploy claims the row in between.
            nextEnvFor: async () => {
              await pool.query(`UPDATE profiles SET status = 'DEPLOYING' WHERE name = 'raced'`);
              return { env: { ADMIN_API_URL: ADMIN_URL }, root } as unknown as NextDeployEnv;
            },
          },
          link,
          { withContainers: async (profile) => ({ ...profile, containers: [] }) as never },
          { publish: () => undefined },
        );

        await assert.rejects(
          rotation.rotate('raced', 'operator'),
          (error: Error) => error instanceof ProfileBusyError && error.currentStatus === 'DEPLOYING',
        );
        assert.deepEqual((await rowOf('raced')).stack_secrets, { ADMIN_API_TOKEN: OTHER }, 'nothing taken out');
      });
    });

    describe("the origin a deployment's own stored token is for", () => {
      const PLACEMENT = { stackVersionId: 1, slotCap: 99, daemonId: 'synthetic-daemon', table: [] };

      async function originOf(name: string): Promise<unknown> {
        const row = await pool.query('SELECT admin_token_origin FROM profiles WHERE name = $1', [name]);
        return row.rows[0]?.admin_token_origin;
      }

      it('is recorded at the insert for a typed token, and null where none is stored', async () => {
        await link.write({ url: ADMIN_URL, token: TOKEN }, 0, 'operator');
        const profiles = new ProfileRepository(pool);

        await profiles.insertWithFreeSlot(
          'typed',
          'streamer',
          'DEPLOYING',
          {},
          PLACEMENT,
          {},
          {
            plain: { ADMIN_API_URL: ADMIN_URL },
            secret: { ADMIN_API_TOKEN: TOKEN },
            adminTokenOrigin: ADMIN_URL,
          },
        );
        await profiles.insertWithFreeSlot(
          'bare',
          'streamer',
          'DEPLOYING',
          {},
          PLACEMENT,
          {},
          { plain: {}, secret: {} },
        );

        assert.equal(await originOf('typed'), ADMIN_URL);
        assert.equal(await originOf('bare'), null);
        assert.equal((await profiles.stackSettingsOf('typed'))?.adminTokenOrigin, ADMIN_URL);
      });

      it('moves with a save that stores or takes out the token, and stays through one that does not', async () => {
        const profiles = new ProfileRepository(pool);
        const row = await profiles.insertWithFreeSlot(
          'saved',
          'streamer',
          'DEPLOYING',
          {},
          PLACEMENT,
          {},
          { plain: {}, secret: {} },
        );
        assert.ok(row);
        const empty = { plain: {}, secret: {}, remove: [], engine: { set: {}, remove: [] } };
        const guard = (expectedRevision: number) => ({ instanceId: row.instance_id, expectedRevision });

        await profiles.updateStackSettings(
          'saved',
          { ...empty, secret: { ADMIN_API_TOKEN: TOKEN }, adminTokenOrigin: ADMIN_URL },
          guard(0),
        );
        assert.equal(await originOf('saved'), ADMIN_URL);
        await profiles.updateStackSettings('saved', { ...empty, plain: { LOG_LEVEL: 'debug' } }, guard(1));
        assert.equal(await originOf('saved'), ADMIN_URL);
        await profiles.updateStackSettings(
          'saved',
          { ...empty, remove: ['ADMIN_API_TOKEN'], adminTokenOrigin: null },
          guard(2),
        );
        assert.equal(await originOf('saved'), null);
      });

      it('is recorded by a deploy only where nothing is recorded yet', async () => {
        const profiles = new ProfileRepository(pool);
        await profiles.insertWithFreeSlot(
          'legacy',
          'streamer',
          'DEPLOYING',
          {},
          PLACEMENT,
          {},
          { plain: {}, secret: { ADMIN_API_TOKEN: TOKEN } },
        );

        await profiles.bindAdminTokenOrigin('legacy', ADMIN_URL);
        await profiles.bindAdminTokenOrigin('legacy', 'https://elsewhere.example.net');

        assert.equal(await originOf('legacy'), ADMIN_URL);
      });
    });
  },
);
