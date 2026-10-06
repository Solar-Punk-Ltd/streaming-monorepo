/**
 * A ladder finishes without a rung that could not finish.
 *
 * ⛔⛔⛔ **Measured live 2026-09-23, on a ten hour ladder broadcast.** The 1080p rung's postage batch
 * filled at 15:15 UTC. When the SRT source dropped at 20:14:43, 360p, 480p and 720p finalized, and
 * 1080p's closing playlist and its recording were both refused with 402, so the orchestrator
 * force-stopped it without a recording, two seconds BEFORE its siblings finished. A ladder counted as
 * finished only once every rung carried an index, and 1080p never would, so the catalog entry said
 * `live` with no index for good. Viewers were shown a dead live broadcast and never a recording.
 *
 * The rule: the broadcast is listed as finished with the rungs that did finish, and a rung that
 * finishes later is added then.
 *
 * Driven through the orchestrator, because the failure is a property of the whole chain: a rung's
 * stop failing is known only to the orchestrator, and what the ladder does about it is only visible
 * in the catalog entry a viewer resolves.
 */

import { Bee, FeedIndex } from '@ethersphere/bee-js';
import { HLS_ENDLIST, ladderFinalizedPattern } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { ADMIN_STATE_LIVE, ADMIN_STATE_VOD, AdminApiClient, AdminStateReport } from '../src/libs/AdminApiClient.js';
import { AdminLadderRegistry } from '../src/libs/AdminLadderRegistry.js';
import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { Logger } from '../src/libs/Logger.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator, StreamOrchestratorConfig } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_VIDEO, Rendition, STREAM_LIFECYCLE_FAILED } from '../src/types.js';

import { fakeRecordingReference, makeFakeRecoveryStore, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const TEST_STREAM_KEY = `${'0'.repeat(63)}1`;
const SETTLE_CEILING_MS = 4_000;

const BASE = 'live/stream';
const FAILING_RUNG = '1080p';
/** Lowest first, which is the order a finished entry lists them in. */
const SIBLINGS = ['360p', '480p', '720p'];
const RUNGS = [...SIBLINGS, FAILING_RUNG];

const rungId = (rung: string): string => `${BASE}_${rung}`;

/** A status bee answers a batch it will not stamp against, and one no retry window spends itself on. */
const PAYMENT_REQUIRED = 402;

function refusedByAFullBatch(): Promise<never> {
  return Promise.reject({ status: PAYMENT_REQUIRED, message: 'batch is overissued' });
}

/** A ladder entry as a reader parses it back out of the catalog feed. */
interface LadderEntry {
  state: string;
  topic: string;
  group?: string;
  recording?: string;
  duration?: number;
  renditions?: Rendition[];
  unfinishedRungs?: string[];
}

/** A catalog feed that hands back whatever was last written to it, which is what four rungs merging need. */
function catalogFeed(payloads: string[]): Bee {
  const latest = () => (payloads.length === 0 ? [] : JSON.parse(payloads[payloads.length - 1]));
  return {
    feed: {
      makeReader: () => ({
        downloadPayload: async (options?: { index?: FeedIndex }) => {
          if (options?.index) {
            return { payload: { toJSON: latest } };
          }
          return { feedIndex: FeedIndex.fromBigInt(BigInt(payloads.length)), payload: { toJSON: latest } };
        },
      }),
      makeWriter: () => ({
        uploadPayload: async (_stamp: string, payload: unknown) => {
          payloads.push(String(payload));
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
    connectivity: {
      isConnected: async () => true,
    },
  } as unknown as Bee;
}

async function standaloneCatalog(payloads: string[]): Promise<StreamCatalog> {
  const publisher = { rung: SINGLE_PUBLISHER, url: 'http://fake-bee:1633', stamp: 'stamp', bee: catalogFeed(payloads) };
  const publishers = { coordinator: () => publisher, forRung: () => publisher } as unknown as BeePublisherPool;
  const catalog = new StreamCatalog(publishers, TEST_STREAM_KEY, 'catalog-topic');
  await catalog.init();
  return catalog;
}

/** The ladder's entry in the newest catalog write, which is the one a viewer reads. */
function ladderEntry(payloads: string[]): LadderEntry | undefined {
  const newest = payloads.at(-1);
  return newest === undefined
    ? undefined
    : (JSON.parse(newest) as LadderEntry[]).find((entry) => entry.group !== undefined);
}

/**
 * An orchestrator running the default four rung ladder, where the node paying for 1080p refuses the
 * two writes that end a broadcast, the closing live window and the recording, exactly as the full
 * batch did on 2026-09-23. Everything else lands, 1080p's segments and live windows included.
 *
 * A segment's reference is its own text here, so every playlist names the rung its segments came from
 * and the refusal can pick out 1080p's.
 */
function orchestratorWhose1080pCannotFinish(
  catalog: StreamCatalog | undefined,
  config: Partial<StreamOrchestratorConfig> = {},
): StreamOrchestrator {
  const isFailingRung = (playlist: string): boolean => playlist.includes(`${FAILING_RUNG}-segment-`);

  return makeTestOrchestrator(
    { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC), ...config },
    {
      uploadData: async (_stamp, data) => {
        const reference = Buffer.from(data).toString('utf-8');
        return { reference: { toHex: () => reference } };
      },
      uploadWindow: async (_identifier, payload) => {
        const playlist = Buffer.from(payload).toString('utf-8');
        if (isFailingRung(playlist) && playlist.includes(HLS_ENDLIST)) {
          return refusedByAFullBatch();
        }
        return { reference: { toHex: () => 'window' } };
      },
      uploadRecording: async (playlist) => {
        if (isFailingRung(playlist)) {
          return refusedByAFullBatch();
        }
        const reference = fakeRecordingReference(playlist);
        return { reference: { toHex: () => reference } };
      },
    },
    makeFakeRecoveryStore(),
    catalog,
  );
}

/** Every rung comes up and publishes one segment, which is what announces it to its ladder. */
function broadcastOneSegmentPerRung(orch: StreamOrchestrator, admin?: AdminSession): void {
  for (const rung of RUNGS) {
    orch.startStream(rungId(rung), MEDIA_TYPE_VIDEO, undefined, admin);
  }
  for (const rung of RUNGS) {
    orch.handleSegment(rungId(rung), 0, 2, Buffer.from(`${rung}-segment-0`));
  }
}

async function stopInOrder(orch: StreamOrchestrator, rungs: readonly string[]): Promise<void> {
  for (const rung of rungs) {
    await orch.stopStream(rungId(rung));
  }
}

/** The two orders a failed rung can stop in, relative to the siblings that do finish. */
const ORDERS = {
  'before its siblings finish, as it did on 2026-09-23': [FAILING_RUNG, ...SIBLINGS],
  'after its siblings finished': [...SIBLINGS, FAILING_RUNG],
} as const;

/** Every line the uploader logs while `run` runs, with the previous sink restored afterwards. */
async function logLinesDuring(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: (_level, line) => lines.push(line) });
  try {
    await run();
  } finally {
    logger.configure(previous);
  }
  return lines;
}

const flipsIn = (lines: string[]): number => lines.filter((line) => ladderFinalizedPattern().test(line)).length;

describe('a standalone ladder whose 1080p rung could not finish', () => {
  for (const [when, order] of Object.entries(ORDERS)) {
    it(`is listed as a recording of the three rungs that finished, when 1080p stops ${when}`, async () => {
      const payloads: string[] = [];
      const orch = orchestratorWhose1080pCannotFinish(await standaloneCatalog(payloads));

      try {
        const lines = await logLinesDuring(async () => {
          broadcastOneSegmentPerRung(orch);
          await waitFor(() => ladderEntry(payloads)?.renditions?.length === RUNGS.length, SETTLE_CEILING_MS);
          await stopInOrder(orch, order);
        });

        assert.equal(
          orch.getStreamStatus(rungId(FAILING_RUNG)).state,
          STREAM_LIFECYCLE_FAILED,
          'the fixture was supposed to force-stop 1080p without a recording, so nothing here is tested',
        );

        const entry = ladderEntry(payloads);
        assert.equal(
          entry?.state,
          'vod',
          'three rungs finished and the fourth never will, and the entry still says live, which is 2026-09-23',
        );
        assert.deepEqual(
          entry?.renditions?.map((rendition) => rendition.name),
          SIBLINGS,
          'a finished entry names only the rungs that have a recording',
        );
        assert.ok(
          entry?.renditions?.every((rendition) => rendition.recording !== undefined),
          'every rung a finished entry names carries the reference of its recording',
        );
        assert.equal(
          entry?.recording,
          entry?.renditions?.[0]?.recording,
          'the entry names its lowest rung′s recording',
        );
        assert.deepEqual(entry?.unfinishedRungs, [FAILING_RUNG], 'and it says which rung the recording lacks');
        assert.equal(entry?.topic, entry?.renditions?.[0]?.topic, 'the entry points a bare client at its lowest rung');

        assert.equal(flipsIn(lines), 1, 'one broadcast ended, so the flip is announced exactly once');
      } finally {
        await orch.cleanup();
      }
    });
  }
});

const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const DECLARED: AdminSession = { id: 'str_01HZY', topic: 'declared-topic-0001' };

interface FakeAdmin {
  client: AdminApiClient;
  /** Every state report it accepted, in order. */
  states: AdminStateReport[];
  /** The ladder it holds, one record per rung name. */
  ladder: Map<string, Rendition>;
}

const isFinishedLadder = (rungs: readonly Rendition[]): boolean =>
  rungs.length > 0 && rungs.every((rung) => rung.recording !== undefined);

/**
 * The admin's side of the two internal routes a ladder in admin mode uses, merging by the rule the
 * admin ships in `apps/web2-admin/backend/src/domain/renditions.ts`, read with `recording` where it
 * reads `index`: a report without a recording keeps the recording already held for that rung on the
 * same topic, the ladder is finished once every rung it holds has one, and `flippedToFinished` is
 * judged against the ladder the report replaced. A `live` report
 * over a recording un-finishes it, as `StreamStateService.apply` does.
 *
 * ⛔ It knows nothing of a rung that will not finish, because the real one cannot: its rendition route
 * refuses any field it does not know. Whatever admin mode does about such a rung has to be done on
 * this side of the wire.
 */
function fakeAdmin(): FakeAdmin {
  const states: AdminStateReport[] = [];
  const ladder = new Map<string, Rendition>();
  let status = 'published';
  let feedIndex = 0;

  const held = (): Rendition[] => [...ladder.values()].sort((a, b) => a.height - b.height);

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;

    if (String(input).endsWith('/state')) {
      const report = body as AdminStateReport;
      if (report.state === ADMIN_STATE_LIVE && status === ADMIN_STATE_VOD) {
        for (const [name, { recording: _recording, duration: _duration, ...live }] of ladder) {
          ladder.set(name, live);
        }
      }
      states.push(report);
      status = report.state;
      return new Response('{}', { status: 200 });
    }

    const incoming = body as Rendition;
    const wasFinished = isFinishedLadder(held());
    const stored = ladder.get(incoming.name);
    const keepsItsRecording =
      incoming.recording === undefined && stored?.recording !== undefined && stored.topic === incoming.topic;
    ladder.set(
      incoming.name,
      keepsItsRecording ? { ...incoming, recording: stored.recording, duration: stored.duration } : incoming,
    );
    const rungs = held();
    const finished = isFinishedLadder(rungs);
    feedIndex += 1;
    return new Response(
      JSON.stringify({
        stream: { id: DECLARED.id, status },
        renditions: rungs,
        ladder: {
          finished,
          flippedToFinished: finished && !wasFinished,
          duration: finished ? Math.max(...rungs.map((rung) => rung.duration ?? 0)) : null,
        },
        feed: { index: feedIndex },
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;

  return {
    client: new AdminApiClient({ baseUrl: ADMIN_URL, token: ADMIN_TOKEN, fetcher, sleep: async () => {} }),
    states,
    ladder,
  };
}

/**
 * The admin answers each rendition report with the ladder it holds, and a finished rung there names its
 * recording by reference. An answer the contract refused would leave the ladder unflipped, so these
 * cases hold the uploader and `renditionAnswerRungSchema` (packages/contracts) to the same shape.
 */
describe('a ladder in admin mode whose 1080p rung could not finish', () => {
  for (const [when, order] of Object.entries(ORDERS)) {
    it(`tells the admin the broadcast became a recording exactly once, when 1080p stops ${when}`, async () => {
      const admin = fakeAdmin();
      const orch = orchestratorWhose1080pCannotFinish(undefined, {
        adminApi: admin.client,
        ladderRegistry: new AdminLadderRegistry({ client: admin.client }),
      });

      try {
        const lines = await logLinesDuring(async () => {
          broadcastOneSegmentPerRung(orch, DECLARED);
          await waitFor(
            () =>
              admin.ladder.size === RUNGS.length && admin.states.some((report) => report.state === ADMIN_STATE_LIVE),
            SETTLE_CEILING_MS,
          );
          await stopInOrder(orch, order);
        });

        assert.equal(
          orch.getStreamStatus(rungId(FAILING_RUNG)).state,
          STREAM_LIFECYCLE_FAILED,
          'the fixture was supposed to force-stop 1080p without a recording, so nothing here is tested',
        );

        const recordings = admin.states.filter((report) => report.state === ADMIN_STATE_VOD);
        assert.equal(
          recordings.length,
          1,
          `the admin was told the broadcast became a recording ${recordings.length} times, and one broadcast ended`,
        );

        const [recording] = recordings;
        assert.equal(
          recording.state === ADMIN_STATE_VOD ? recording.recording : null,
          admin.ladder.get(SIBLINGS[0])?.recording,
          'the admin is told the ladder′s recording, its lowest finished rung′s',
        );

        assert.equal(flipsIn(lines), 1, 'one broadcast ended, so the flip is announced exactly once');
      } finally {
        await orch.cleanup();
      }
    });
  }
});
