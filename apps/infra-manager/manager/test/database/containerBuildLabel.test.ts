/**
 * The release each container's build was made as, migration 051, against a
 * real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with DEPLOYMENT_SETTINGS_TEST_PG_PORT set.
 *
 * An observation after a deploy writes the build, the commit and the release
 * each container was started from, and a deployment's page reads them back.
 * This shows the repository writes the release and reads it back, that a later
 * observation replaces it, a build made with none included, that a record an
 * older manager wrote reads as one with no release, and that the column takes
 * nothing a label may not be.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';

const port = Number(process.env.DEPLOYMENT_SETTINGS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'deployment_settings_test',
  connectionTimeoutMillis: 10000,
};

const THIS_MIGRATION = '051_';
const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';

describe(
  'the release a container record keeps, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let containers: ContainerRepository;

    async function migrate(target: Pool, range: { from?: string; until?: string } = {}): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        if (range.from && name < range.from) continue;
        if (range.until && name >= range.until) break;
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    async function insertProfile(name: string, slot: number): Promise<void> {
      await pool.query(
        `INSERT INTO profiles (name, port_slot, kind, stack_version_id)
       VALUES ($1, $2, 'viewer', (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
        [name, slot],
      );
    }

    beforeEach(async () => {
      schema = `container_label_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      containers = new ContainerRepository(pool);
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it('writes the release with the build and the commit, reads it back, and a later observation replaces it', async () => {
      await migrate(pool);
      await insertProfile('watch', 3);
      await containers.upsert('watch', buildContainerSnapshot('client', { CLIENT_PORT: '10034' }));

      await containers.setBuild('watch', 'client', COMMIT, COMMIT, 'QA-build-2026-10-07');
      assert.deepEqual(
        (await containers.listApiContainers('watch')).map(({ buildId, buildCommit, buildLabel }) => ({
          buildId,
          buildCommit,
          buildLabel,
        })),
        [{ buildId: COMMIT, buildCommit: COMMIT, buildLabel: 'QA-build-2026-10-07' }],
      );

      await containers.setBuild('watch', 'client', `${COMMIT}-r1`, COMMIT, null);
      const [record] = await containers.listForProfile('watch');
      assert.equal(record?.build_id, `${COMMIT}-r1`);
      assert.equal(record?.build_label, null, 'a build made with none replaces the label rather than keeping it');
    });

    it('reads a record written before the column as one with no release', async () => {
      await migrate(pool, { until: THIS_MIGRATION });
      await insertProfile('legacy', 4);
      await pool.query(
        `INSERT INTO containers (profile_name, service, build_id, build_commit)
         VALUES ('legacy', 'client', $1, $1)`,
        [COMMIT],
      );

      await migrate(pool, { from: THIS_MIGRATION });
      const [container] = await containers.listApiContainers('legacy');

      assert.equal(container?.buildCommit, COMMIT);
      assert.equal(container?.buildLabel, null);
    });

    it('refuses a value no label may be', async () => {
      await migrate(pool);
      await insertProfile('watch', 3);
      await containers.upsert('watch', buildContainerSnapshot('client', { CLIENT_PORT: '10034' }));

      for (const value of ['', 'two words', "it's", 'x'.repeat(97)]) {
        await assert.rejects(
          containers.setBuild('watch', 'client', COMMIT, COMMIT, value),
          (error: unknown) => (error as { code?: string }).code === '23514',
          JSON.stringify(value),
        );
      }
      assert.equal((await containers.listApiContainers('watch'))[0]?.buildLabel, null);
    });
  },
);
