/**
 * A new deployment never gets a slot that puts one of its ports on a port the
 * fetch standard blocks.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/. On 2026-10-07
 * slot 8 gave an uploader the API port 10080, which Node's fetch and every
 * browser refuse as a bad port, so the uploader's own healthcheck could never
 * pass and the admin read the stage as not answering.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PoolClient } from 'pg';

import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import { freeSlotFor } from '../../src/domain/ports/reservationSql.js';
import { BUNDLED_PORT_TABLE } from '../../src/domain/versions/portTable.js';

/** The slots the allocator offers its query, which picks the lowest free one among them. */
async function candidateSlots(slotCap: number): Promise<number[]> {
  let offered: number[] = [];
  const client = {
    query: async (_sql: string, params: unknown[]) => {
      offered = params[0] as number[];
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await freeSlotFor(client, { slotCap, daemonId: 'local', table: BUNDLED_PORT_TABLE });
  return offered;
}

describe('freeSlotFor and the fetch standard blocked ports', () => {
  it('lands the bundled API port on 10080 at slot 8, the case it guards', () => {
    const api = portPlanFor(BUNDLED_PORT_TABLE, 8).find((entry) => entry.portVar === 'API_PORT');
    assert.equal(api?.port, 10080);
  });

  it('never offers slot 8, whose API port the fetch standard blocks', async () => {
    const offered = await candidateSlots(20);
    assert.ok(!offered.includes(8), `slot 8 was offered: ${offered.join(',')}`);
  });

  it('offers every other slot, so a blocked port costs one slot and no more', async () => {
    const offered = await candidateSlots(20);
    assert.deepEqual(
      offered,
      Array.from({ length: 20 }, (_, index) => index + 1).filter((slot) => slot !== 8),
    );
  });
});
