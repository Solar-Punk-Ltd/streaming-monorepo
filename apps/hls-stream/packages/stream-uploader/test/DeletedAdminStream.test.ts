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
import { Logger } from '../src/libs/Logger.js';
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
  /** Every rendition report the admin refused, as its body, in order. */
  refusedRenditions: Rendition[];
  /** From now on every report is answered with this. */
  refuseWith(refusal: Refusal): void;
}

/** An admin that takes every report until told to refuse them all one way. */
function fakeAdmin(): FakeAdmin {
  const states: AdminStateReport[] = [];
  const rungs = new Set<string>();
  const held: Rendition[] = [];
  const refusedRenditions: Rendition[] = [];
  let refusal: Refusal | null = null;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (refusal !== null) {
      if (String(input).endsWith('/renditions')) {
        refusedRenditions.push(JSON.parse(String(init?.body)) as Rendition);
      }
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
    refusedRenditions,
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

/**
 * The last rung's finalize finishes the ladder, and the `vod` report that names the recording is the
 * one the admin refuses because the stream was deleted in the admin at that moment. The three rungs
 * before it finalized cleanly and gave their entries up, so this rung's entry is the only one left.
 */
describe('a ladder whose stream the admin deletes as its last rung reports the recording', () => {
  /** An admin that merges every rung, flips the ladder when all of them carry an index, and refuses the vod report. */
  function adminDeletingAtTheVodReport(): FakeAdmin {
    const states: AdminStateReport[] = [];
    const rungs = new Set<string>();
    const held = new Map<string, Rendition>();
    const isFinished = () => held.size === RUNGS.length && [...held.values()].every((r) => r.index !== undefined);

    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      if (String(input).endsWith('/state')) {
        const report = body as AdminStateReport;
        if (report.state !== ADMIN_STATE_LIVE) {
          return new Response(JSON.stringify(STREAM_DELETED.body), { status: STREAM_DELETED.status });
        }
        states.push(report);
        return new Response('{}', { status: 200 });
      }
      const rendition = body as Rendition;
      const wasFinished = isFinished();
      rungs.add(rendition.name);
      held.set(rendition.name, rendition);
      const finished = isFinished();
      return new Response(
        JSON.stringify({
          stream: { id: DECLARED.id, status: ADMIN_STATE_LIVE },
          renditions: [...held.values()],
          ladder: { finished, flippedToFinished: finished && !wasFinished, duration: finished ? 2 : null },
          feed: { index: held.size },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    return {
      client: new AdminApiClient({ baseUrl: ADMIN_URL, token: ADMIN_TOKEN, fetcher, sleep: async () => {} }),
      states,
      rungs,
      refusedRenditions: [],
      refuseWith: () => {},
    };
  }

  it('lets the last rung′s recovery entry go when that vod report meets stream_not_found', async () => {
    const store = newStore();
    const admin = adminDeletingAtTheVodReport();
    const orch = adminOrchestrator(admin, store, { feedHead: () => null });
    try {
      for (const streamId of LADDER.streamIds) {
        orch.startStream(streamId, MEDIA_TYPE_VIDEO, undefined, DECLARED);
      }
      for (const streamId of LADDER.streamIds) {
        orch.handleSegment(streamId, 0, 2, Buffer.from(`${streamId}-segment-0`));
      }
      await waitFor(() => LADDER.isUp(admin) && store.listActive().length === RUNGS.length, SETTLE_CEILING_MS);

      for (const streamId of LADDER.streamIds) {
        await orch.stopStream(streamId);
      }
      const last = LADDER.streamIds.at(-1)!;
      assert.equal(
        orch.getStreamStatus(last).state,
        STREAM_LIFECYCLE_FAILED,
        'the vod report was refused, so the last finalize was supposed to fail and nothing here is tested',
      );
    } finally {
      await orch.cleanup();
    }

    assert.deepEqual(store.listActive(), [], 'a deleted stream′s last entry was kept to be refused at every boot');
  });
});

/**
 * ⛔⛔ **Measured live 2026-10-08 on the test stack, after the two fixes above were deployed.** The deleted
 * stream's 1080p entry recovered at boot and its finalize failed before any rendition report, because the
 * rung could not tell whether it had published its recording before the crash. The orchestrator then
 * reported the rung as stopped without a recording, the admin answered that report 404 with
 * `stream_not_found`, and the entry stayed on disk, because nothing on that path let it go.
 */
describe('a recovered rung whose finalize fails before its report, of a stream the admin no longer knows', () => {
  /** A head read bee refuses outright, which no retry window spends itself on. */
  const headRefused = (): never => {
    throw { status: 400, message: 'feed head refused' };
  };

  /**
   * A ladder broadcast that crashed mid-way: its entries are copied off the disk while it is live, which
   * is what a killed process leaves. The live broadcast itself is then cleaned up against the original.
   */
  async function entriesACrashLeft(): Promise<RecoveryStore> {
    const live = newStore();
    const admin = fakeAdmin();
    const orch = adminOrchestrator(admin, live, { feedHead: () => null });
    try {
      for (const rung of RUNGS) {
        orch.startStream(rungId(rung), MEDIA_TYPE_VIDEO, undefined, DECLARED);
      }
      for (const rung of RUNGS) {
        orch.handleSegment(rungId(rung), 0, 2, Buffer.from(`${rung}-segment-0`));
      }
      await waitFor(
        () => admin.rungs.size === RUNGS.length && live.listActive().length === RUNGS.length,
        SETTLE_CEILING_MS,
      );
      const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-admin-stream-crash-'));
      stateDirs.push(crashed);
      for (const streamId of live.listActive()) {
        const state = live.load(streamId);
        assert.ok(state, `entry ${streamId} did not read back`);
        new RecoveryStore(crashed).save(streamId, state);
      }
      return new RecoveryStore(crashed);
    } finally {
      await orch.cleanup();
    }
  }

  /** The next boot recovers every rung, and each recovery times out into a finalize that cannot read its head. */
  async function recoverAndFinalizeWhileAdminRefuses(store: RecoveryStore, refusal: Refusal): Promise<FakeAdmin> {
    const admin = fakeAdmin();
    admin.refuseWith(refusal);
    const orch = adminOrchestrator(admin, store, { feedHead: headRefused });
    try {
      assert.equal((await orch.recoverStreams()).length, RUNGS.length, 'every rung was supposed to recover');
      for (const rung of RUNGS) {
        await orch.stopStream(rungId(rung));
        assert.equal(orch.getStreamStatus(rungId(rung)).state, STREAM_LIFECYCLE_FAILED);
      }
    } finally {
      await orch.cleanup();
    }
    return admin;
  }

  it('lets each entry go when the stopped-without-a-recording report meets stream_not_found', async () => {
    const store = await entriesACrashLeft();
    const admin = await recoverAndFinalizeWhileAdminRefuses(store, STREAM_DELETED);

    assert.ok(
      admin.refusedRenditions.length > 0 && admin.refusedRenditions.every((report) => report.index === undefined),
      'the finalize was supposed to fail before any report naming a recording, so only the unfinished report reached the admin',
    );
    assert.deepEqual(store.listActive(), [], 'a deleted stream′s entries were kept to be refused at every boot');
  });

  /** A finalize refused this way is followed by the unfinished report, refused the same way, and one line says it. */
  it('says once per rung that it let the entry go, though two reports were refused', async () => {
    const lines: string[] = [];
    const logger = Logger.getInstance();
    const previous = logger.configure({ sink: (_level, line) => lines.push(line) });
    try {
      await broadcastThenStopWhileAdminRefuses(STREAM_DELETED);
    } finally {
      logger.configure(previous);
    }

    for (const rung of RUNGS) {
      assert.equal(
        lines.filter((line) => line.includes(`${rungId(rung)} drops its recovery entry`)).length,
        1,
        `rung ${rung} said it dropped its entry other than once`,
      );
    }
  });

  it('keeps each entry when that report meets an admin that is only unavailable', async () => {
    const store = await entriesACrashLeft();
    await recoverAndFinalizeWhileAdminRefuses(store, ADMIN_UNAVAILABLE);

    assert.deepEqual([...store.listActive()].sort(), RUNGS.map(rungId).sort());
  });

  it('keeps each entry when that report meets a 404 that does not name the stream as missing', async () => {
    const store = await entriesACrashLeft();
    await recoverAndFinalizeWhileAdminRefuses(store, PATH_NOT_ROUTED);

    assert.deepEqual([...store.listActive()].sort(), RUNGS.map(rungId).sort());
  });
});
