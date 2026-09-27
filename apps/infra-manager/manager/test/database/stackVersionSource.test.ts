/**
 * Where each version's stack comes from, as the versions table records it.
 *
 * Every row that exists when migration 043 runs was built from swarm-hls-stream,
 * whose whole tree is the stack, and keeps saying so. A row inserted after it
 * names the repository it is fetched from, and learns the folder its build
 * took the stack from when that build publishes.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };

const SWARM_HLS_STREAM = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';
const MONOREPO = 'https://github.com/Solar-Punk-Ltd/streaming-monorepo.git';
const SOURCE_MIGRATION = '043_stack_version_source.sql';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('the source of each stack version in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let versions: PostgresStackVersionRepository;
  const migrations = new URL('../../src/migrations/', import.meta.url);

  async function migrate(which: (file: string) => boolean): Promise<void> {
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      if (which(file)) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
  }

  beforeEach(async () => {
    schema = `t04b_source_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000` });
    versions = new PostgresStackVersionRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('records swarm-hls-stream and its whole tree on every row that exists, and changes nothing else about it', async () => {
    await migrate(file => file < SOURCE_MIGRATION);
    await pool.query(
      `INSERT INTO stack_versions (name, git_ref, commit_sha, status, root_path, layout, build_id, tested)
       VALUES ('v3-4', 'v3.4', $1, 'ready', '/synthetic/v3-4', 'builds', $1, true)`,
      [A],
    );
    const before = await pool.query('SELECT * FROM stack_versions ORDER BY id');

    await migrate(file => file === SOURCE_MIGRATION);

    const after = await pool.query('SELECT * FROM stack_versions ORDER BY id');
    assert.equal(after.rows.length, 2, 'the bundled row and the added one');
    for (const [index, row] of after.rows.entries()) {
      const { source_url: url, source_folder: folder, ...rest } = row;
      assert.equal(url, SWARM_HLS_STREAM, row.name);
      assert.equal(folder, '.', row.name);
      assert.deepEqual(rest, before.rows[index], `${row.name} changed in more than its source`);
    }
  });

  it('refuses a row that names no repository to fetch from', async () => {
    await migrate(() => true);

    await assert.rejects(
      pool.query("INSERT INTO stack_versions (name, git_ref, status) VALUES ('nowhere', 'main', 'building')"),
      /source_url/,
    );
  });

  it('refuses a repository that is not an https GitHub clone address, and a folder that could leave the tree', async () => {
    await migrate(() => true);
    const insert = (url: string, folder: string | null) => pool.query(
      "INSERT INTO stack_versions (name, git_ref, status, source_url, source_folder) VALUES ('odd', 'main', 'building', $1, $2)",
      [url, folder],
    );

    await assert.rejects(insert('file:///srv/stack.git', null), /stack_versions_source_url_format/);
    await assert.rejects(insert('https://example.org/stack.git', null), /stack_versions_source_url_format/);
    for (const folder of ['../apps', 'apps/../..', '/apps', '-apps', 'apps/', '', '.hidden']) {
      await assert.rejects(insert(MONOREPO, folder), /stack_versions_source_folder_format/, JSON.stringify(folder));
    }
    await insert(MONOREPO, 'apps/hls-stream');
  });

  it('inserts a version with its repository and no folder until a build publishes one', async () => {
    await migrate(() => true);

    const added = await versions.insert({ name: 'main', gitRef: 'main', rootPath: '/synthetic/main', sourceUrl: MONOREPO });

    assert.deepEqual(added.source, { url: MONOREPO, folder: null });
    assert.deepEqual((await versions.findById(added.id))!.source, { url: MONOREPO, folder: null });
  });

  it('writes the source of the build it publishes, and keeps it through a publication that names none', async () => {
    await migrate(() => true);
    const added = await versions.insert({ name: 'main', gitRef: 'main', rootPath: '/synthetic/main', sourceUrl: MONOREPO });

    const built = await versions.publish(added.id, {
      buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT, source: { url: MONOREPO, folder: 'apps/hls-stream' },
    });
    assert.deepEqual(built!.source, { url: MONOREPO, folder: 'apps/hls-stream' });

    const again = await versions.publish(added.id, { buildId: `${A}-r1`, commitSha: A, contract: ALLOCATION_CONTRACT });
    assert.deepEqual(again!.source, { url: MONOREPO, folder: 'apps/hls-stream' });

    await versions.markBuilding(added.id, 'stack/v3.4');
    await versions.markUpdateFailed(added.id, 'synthetic failure');
    assert.deepEqual((await versions.findById(added.id))!.source, { url: MONOREPO, folder: 'apps/hls-stream' });
  });

  it('moves the bundled row onto another repository when a build from there publishes', async () => {
    await migrate(() => true);
    const bundled = (await versions.findByName('bundled'))!;
    assert.deepEqual(bundled.source, { url: SWARM_HLS_STREAM, folder: '.' });

    const moved = await versions.publish(bundled.id, {
      buildId: B, commitSha: B, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled',
      source: { url: MONOREPO, folder: 'apps/hls-stream' },
    });

    assert.deepEqual(moved!.source, { url: MONOREPO, folder: 'apps/hls-stream' });
    assert.equal(moved!.buildId, B);
  });
});
