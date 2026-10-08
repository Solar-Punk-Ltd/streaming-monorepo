/**
 * A broadcast whose stream the admin deleted is let go of, rather than recovered at every boot.
 *
 * ⛔⛔ **Measured live 2026-10-08.** A ladder's stream was deleted on the admin while its recovery
 * entries were still on disk. Every uploader start recovered all of its rungs, waited out the reconnect
 * window, resumed each finalize at the catalog write and was refused with 404 for the rung's report. A
 * failed finalize keeps its entry on purpose (see `StreamOrchestrator.drainUploader`), so the same
 * entries came back at the next start, and the one after, each time costing a minute's wait, a refused
 * report per rung and a wrong active stream count.
 *
 * The admin saying the stream does not exist is the one refusal that is permanent, so that one lets the
 * entry go. Every other failure keeps it, because those heal and the entry is how the next boot finishes
 * the recording.
 *
 * Driven through the orchestrator over a real recovery store, because "the next boot does not see it" is
 * a property of the files on disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { ADMIN_STATE_LIVE, AdminApiClient, AdminStateReport } from '../src/libs/AdminApiClient.js';
import { AdminLadderRegistry } from '../src/libs/AdminLadderRegistry.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_VIDEO, Rendition, STREAM_LIFECYCLE_FAILED } from '../src/types.js';

import { FakeUploads, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const SETTLE_CEILING_MS = 4_000;
const BASE = 'live/stream';
const RUNGS = AbrLadder.parse(DEFAULT_LADDER_SPEC)
  .rungs()
  .map((rung) => rung.name);
const rungId = (rung: string): string => `${BASE}_${rung}`;

const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const DECLARED: AdminSession = { id: 'str_01HZY', topic: 'declared-topic-0001' };

/** What the admin answers every report with once the broadcast is up, as a status and a body. */
interface Refusal {
  status: number;
  body: unknown;
}

const STREAM_DELETED: Refusal = { status: 404, body: { error: 'stream_not_found', id: DECLARED.id } };
const ADMIN_UNAVAILABLE: Refusal = { status: 503, body: { error: 'unavailable' } };
/** The 404 a wrong base url or a proxy answers, which says nothing about the stream. */
const PATH_NOT_ROUTED: Refusal = { status: 404, body: { error: 'not_found', path: '/api/internal/streams' } };

interface FakeAdmin {
  client: AdminApiClient;
  states: AdminStateReport[];
  rungs: Set<string>;
  /** From now on every report is answered with this. */
  refuseWith(refusal: Refusal): void;
}

/** An admin that takes every report until told to refuse them all one way. */
function fakeAdmin(): FakeAdmin {
  const states: AdminStateReport[] = [];
  const rungs = new Set<string>();
  const held: Rendition[] = [];
  let refusal: Refusal | null = null;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (refusal !== null) {
      return new Response(JSON.stringify(refusal.body), { status: refusal.status });
    }
    const body = JSON.parse(String(init?.body)) as unknown;
    if (String(input).endsWith('/state')) {
      states.push(body as AdminStateReport);
      return new Response('{}', { status: 200 });
    }
    const rendition = body as Rendition;
    rungs.add(rendition.name);
    held.push(rendition);
    return new Response(
      JSON.stringify({
        stream: { id: DECLARED.id, status: ADMIN_STATE_LIVE },
        renditions: held,
        ladder: { finished: false, flippedToFinished: false, duration: null },
        feed: { index: held.length },
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;

  return {
    client: new AdminApiClient({ baseUrl: ADMIN_URL, token: ADMIN_TOKEN, fetcher, sleep: async () => {} }),
    states,
    rungs,
    refuseWith: (next) => {
      refusal = next;
    },
  };
}

const stateDirs: string[] = [];
after(() => {
  for (const dir of stateDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A master feed that takes every write. */
const acceptingMasterWriter = {
  publish: async (group: string) => ({ topic: group, index: 0 }),
} as unknown as MasterFeedWriter;

function adminOrchestrator(
  admin: FakeAdmin,
  store: RecoveryStore,
  uploads: FakeUploads,
  ladder = true,
): StreamOrchestrator {
  return makeTestOrchestrator(
    ladder
      ? {
          ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
          adminApi: admin.client,
          ladderRegistry: new AdminLadderRegistry({ client: admin.client, masterWriter: acceptingMasterWriter }),
        }
      : { adminApi: admin.client },
    uploads,
    store,
  );
}

/** One broadcast shape: the stream ids it publishes under and whether the admin holds it as a ladder. */
interface Shape {
  streamIds: string[];
  ladder: boolean;
  /** Whether the admin has taken what this shape reports once it is up. */
  isUp(admin: FakeAdmin): boolean;
}

const LADDER: Shape = {
  streamIds: RUNGS.map(rungId),
  ladder: true,
  isUp: (admin) => admin.rungs.size === RUNGS.length,
};

/** One rendition, which the admin is told about through its state report alone. */
const SINGLE_RENDITION: Shape = {
  streamIds: [BASE],
  ladder: false,
  isUp: (admin) => admin.states.some((report) => report.state === ADMIN_STATE_LIVE),
};

function newStore(): RecoveryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-admin-stream-'));
  stateDirs.push(dir);
  return new RecoveryStore(dir);
}

/**
 * Broadcast one segment per stream, have the admin refuse every report from then on, and stop each
 * stream, which is the finalize the live log showed failing at its report. Answers the store the
 * entries are in.
 */
async function broadcastThenStopWhileAdminRefuses(refusal: Refusal, shape: Shape = LADDER): Promise<RecoveryStore> {
  const store = newStore();
  const admin = fakeAdmin();
  // A broadcast that has written nothing yet, so its first live publish opens the feed.
  const orch = adminOrchestrator(admin, store, { feedHead: () => null }, shape.ladder);

  try {
    for (const streamId of shape.streamIds) {
      orch.startStream(streamId, MEDIA_TYPE_VIDEO, undefined, DECLARED);
    }
    for (const streamId of shape.streamIds) {
      orch.handleSegment(streamId, 0, 2, Buffer.from(`${streamId}-segment-0`));
    }
    await waitFor(() => shape.isUp(admin) && store.listActive().length === shape.streamIds.length, SETTLE_CEILING_MS);

    admin.refuseWith(refusal);
    for (const streamId of shape.streamIds) {
      await orch.stopStream(streamId);
      assert.equal(
        orch.getStreamStatus(streamId).state,
        STREAM_LIFECYCLE_FAILED,
        'the report was refused, so the finalize was supposed to fail and nothing here is tested',
      );
    }
  } finally {
    await orch.cleanup();
  }
  return store;
}

/** What the next uploader start recovers from the same directory. */
async function nextBootRecovers(store: RecoveryStore, shape: Shape = LADDER): Promise<string[]> {
  // The feed a crash left mid-broadcast, which is what the head of a recovered rung answers. Read as
  // never written, the recovered finalizes this boot's cleanup runs retry the head for many seconds.
  const orch = adminOrchestrator(fakeAdmin(), store, {}, shape.ladder);
  try {
    return await orch.recoverStreams();
  } finally {
    await orch.cleanup();
  }
}

describe('a broadcast whose stream the admin no longer knows', () => {
  it('lets each rung′s recovery entry go when the admin answers that the stream does not exist', async () => {
    const store = await broadcastThenStopWhileAdminRefuses(STREAM_DELETED);

    assert.deepEqual(store.listActive(), [], 'a deleted stream′s entries were kept to be refused at every boot');
    assert.deepEqual(await nextBootRecovers(store), []);
  });

  it('keeps every entry when the admin is only unavailable, so the next boot can still finish it', async () => {
    const store = await broadcastThenStopWhileAdminRefuses(ADMIN_UNAVAILABLE);

    assert.deepEqual(
      [...(await nextBootRecovers(store))].sort(),
      RUNGS.map(rungId).sort(),
      'an admin that was down for a moment cost the recording',
    );
  });
});

describe('a single-rendition broadcast whose stream the admin no longer knows', () => {
  it('lets its recovery entry go when the admin answers its recording report that the stream does not exist', async () => {
    const store = await broadcastThenStopWhileAdminRefuses(STREAM_DELETED, SINGLE_RENDITION);

    assert.deepEqual(store.listActive(), [], 'a deleted stream′s entry was kept to be refused at every boot');
    assert.deepEqual(await nextBootRecovers(store, SINGLE_RENDITION), []);
  });

  it('keeps its entry when the admin is only unavailable, so the next boot can still finish it', async () => {
    const store = await broadcastThenStopWhileAdminRefuses(ADMIN_UNAVAILABLE, SINGLE_RENDITION);

    assert.deepEqual(await nextBootRecovers(store, SINGLE_RENDITION), [BASE]);
  });

  it('keeps its entry when the admin answers a 404 that does not name the stream as missing', async () => {
    const store = await broadcastThenStopWhileAdminRefuses(PATH_NOT_ROUTED, SINGLE_RENDITION);

    assert.deepEqual(await nextBootRecovers(store, SINGLE_RENDITION), [BASE]);
  });
});
