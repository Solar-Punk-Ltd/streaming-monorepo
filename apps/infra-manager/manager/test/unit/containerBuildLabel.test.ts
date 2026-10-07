/**
 * What a deployment answers about the build each of its containers runs: the
 * build, its commit and the release it was made as, as the containers table
 * keeps them since migration 051.
 *
 * Unit test over a pool that records what it is asked and answers rows of the
 * test's own, no database. `pnpm test` in manager/. The same statements run
 * against PostgreSQL in test/database/containerBuildLabel.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { ContainerRepository, type ContainerRow } from '../../src/domain/ContainerRepository.js';

const COMMIT = '635b4e1753cd35d06191fdd54a1f426f7478d438';

interface Asked {
  text: string;
  values: unknown[];
}

function recordingPool(rows: readonly ContainerRow[] = []): { pool: Pool; asked: Asked[] } {
  const asked: Asked[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      asked.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, asked };
}

function row(service: string, buildLabel: string | null): ContainerRow {
  return {
    profile_name: 'watch',
    service,
    ports: {},
    env: {},
    env_salt: null,
    env_digests: {},
    build_id: COMMIT,
    build_commit: COMMIT,
    build_label: buildLabel,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

describe("the containers a deployment's answer carries", () => {
  it('name the release of the build each one runs, beside the build and its commit', async () => {
    const { pool } = recordingPool([row('client', 'QA-build-2026-10-07'), row('bee-gateway', null)]);

    const containers = await new ContainerRepository(pool).listApiContainers('watch');

    assert.deepEqual(containers, [
      { service: 'client', ports: {}, buildId: COMMIT, buildCommit: COMMIT, buildLabel: 'QA-build-2026-10-07' },
      { service: 'bee-gateway', ports: {}, buildId: COMMIT, buildCommit: COMMIT, buildLabel: null },
    ]);
  });

  it('are read with the label column', async () => {
    const { pool, asked } = recordingPool();

    await new ContainerRepository(pool).listForProfile('watch');

    assert.match(asked[0]?.text ?? '', /\bbuild_label\b/);
    assert.deepEqual(asked[0]?.values, ['watch']);
  });
});

describe('what an observation of a container writes', () => {
  it('writes the release beside the build and the commit, and null for a build made with none', async () => {
    const { pool, asked } = recordingPool();
    const containers = new ContainerRepository(pool);

    await containers.setBuild('watch', 'client', COMMIT, COMMIT, 'QA-build-2026-10-07');
    await containers.setBuild('watch', 'client', `${COMMIT}-r1`, COMMIT, null);

    assert.match(asked[0]?.text ?? '', /build_label = \$5/);
    assert.deepEqual(
      asked.map((query) => query.values),
      [
        ['watch', 'client', COMMIT, COMMIT, 'QA-build-2026-10-07'],
        ['watch', 'client', `${COMMIT}-r1`, COMMIT, null],
      ],
    );
  });
});
