/**
 * A rung coming back to a ladder whose other rungs are publishing, in the shapes a review of the
 * one-timeline fix found it still split: bounced again before its feed head read answered, its first
 * upload lost, a ladder opening on a declaration that already has a recording, and a rung behind on
 * its uploads when it resumes in a partial return.
 *
 * ⛔ Every case asserts the design rule itself: the same cut carries one sequence and one
 * `#EXT-X-PROGRAM-DATE-TIME` on every rung. See `swarm-hls-rungs-share-one-timeline` and the README's
 * "Every rung of a live ladder dates from the ladder's one current line".
 *
 * Nothing here asserts a timing. The clocks are injected and stepped, and the one real wait is the
 * fake node's head read, which is the case's subject rather than a measurement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { AdminApiClient, STATE_REPORT_ACCEPTED } from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeFakeRecoveryStore, makeTestOrchestrator, TEST_ANCHOR } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const REAP_MS = 60_000;
/** A ceiling on a hung wait, not a measurement. */
const SETTLE_CEILING_MS = 12_000;
const SEGMENT_SECONDS = 2;
/** How long the fake node takes to answer a feed head read, in the cases about that window. */
const SLOW_HEAD_READ_MS = 1_500;
const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic-0001' };
const RUNG_NAMES = ['360p', '480p', '720p', '1080p'] as const;
const LADDER_BASE = 'audio/ladder-stream';
const VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';
const rungIds = RUNG_NAMES.map((rung) => `${LADDER_BASE}_${rung}`);
const [rung360, , , rung1080] = rungIds;
const fastRungs = rungIds.slice(0, 3);

interface ManifestWrite {
  index: number;
  playlist: string;
  topic: string;
}

interface PlaylistEntry {
  sequence: number;
  uri: string;
  programDateTimeMs: number;
}

interface RejoinHarness {
  orchestrator: StreamOrchestrator;
  writes: ManifestWrite[];
  start: (streamId: string) => void;
  /** The engine of this rung opened a new publish session, so its counter starts at 0 again. */
  restartCounter: (streamId: string) => void;
  /** Hand one segment over and wait for its upload to finish, landed or refused. */
  deliver: (streamId: string, label: string) => Promise<void>;
  /** Hand one segment over without waiting, for a rung whose uploads are held. */
  handOver: (streamId: string, label: string) => void;
  /** Hold every upload of this rung until the returned release is called. */
  hold: (streamId: string) => () => void;
  landed: (streamId: string, label: string) => Promise<void>;
  published: (streamId: string, label: string) => Promise<void>;
  passTime: (ms: number) => Promise<void>;
}

function rejoinHarness(options: { headReadMs?: number; refusedLabels?: Set<string> } = {}): RejoinHarness {
  const clock = new FakeClock();
  let wallMs = TEST_ANCHOR.startedAtMs;
  const writes: ManifestWrite[] = [];
  const uploadedSegments: string[] = [];
  const feeds = new Map<string, { index: number; manifest: string }>();
  const heldUploads = new Map<string, Promise<void>>();
  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async () => STATE_REPORT_ACCEPTED,
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      clock,
      wallClock: () => wallMs,
      orphanReapMs: REAP_MS,
      ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        const held = [...heldUploads].find(([streamId]) => label.startsWith(`${streamId}-`));
        if (held !== undefined) await held[1];
        uploadedSegments.push(label);
        if (options.refusedLabels?.delete(label)) {
          // A status bee answers that is not worth retrying, so the segment is given up at once.
          return Promise.reject({ status: 400, message: 'refused by the test' });
        }
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: (topic) => feeds.get(topic) ?? null,
      uploadPayload: async (index, payload, topic) => {
        const playlist = String(payload);
        writes.push({ index, playlist, topic });
        feeds.set(topic, { index, manifest: playlist });
        return { reference: { toHex: () => `soc-${index}` } };
      },
      ...(options.headReadMs === undefined
        ? {}
        : { deadlines: { poolTimeoutMs: 120_000, headReadMs: options.headReadMs } }),
    },
    makeFakeRecoveryStore(),
  );

  const next = new Map(rungIds.map((streamId) => [streamId, 0]));
  const handOver = (streamId: string, label: string) => {
    const index = next.get(streamId)!;
    assert.deepEqual(
      orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(`${streamId}-${label}`)),
      { accepted: true },
      `${streamId}-${label} must be taken`,
    );
    next.set(streamId, index + 1);
  };
  const landed = async (streamId: string, label: string) => {
    await waitFor(() => uploadedSegments.includes(`${streamId}-${label}`), SETTLE_CEILING_MS);
  };

  return {
    orchestrator,
    writes,
    start: (streamId) => {
      assert.equal(orchestrator.startStream(streamId, MEDIA_TYPE_AUDIO, undefined, DECLARATION), true, streamId);
    },
    restartCounter: (streamId) => next.set(streamId, 0),
    deliver: async (streamId, label) => {
      handOver(streamId, label);
      await landed(streamId, label);
    },
    handOver,
    hold: (streamId) => {
      let release = () => {};
      heldUploads.set(
        streamId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        heldUploads.delete(streamId);
        release();
      };
    },
    landed,
    published: async (streamId, label) => {
      await waitFor(
        () => writes.some((write) => write.playlist.includes(`segment-${streamId}-${label}`)),
        SETTLE_CEILING_MS,
      );
    },
    passTime: async (ms) => {
      wallMs += ms;
      await clock.advance(ms);
    },
  };
}

function entriesOf(playlist: string): PlaylistEntry[] {
  const declared = /^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m.exec(playlist);
  assert.ok(declared, 'every playlist declares its media sequence');
  let sequence = Number(declared[1]);
  let programDateTimeMs = Number.NaN;
  const entries: PlaylistEntry[] = [];
  for (const line of playlist.split('\n').map((text) => text.trim())) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      programDateTimeMs = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    } else if (line.startsWith('segment-') || line.startsWith('gap-')) {
      entries.push({ sequence: sequence++, uri: line, programDateTimeMs });
    }
  }
  return entries;
}

/**
 * Asserts that each row's segments, one label per rung, sit at one sequence with one date, read off
 * each rung's newest live playlist naming its `last` label.
 *
 * @param rows one entry per cut: the label each rung delivered it under, in `rungIds` order.
 */
async function assertOneTimeline(
  harness: RejoinHarness,
  rows: readonly (readonly string[])[],
  last: readonly string[],
): Promise<void> {
  const playlists = new Map<string, PlaylistEntry[]>();
  for (const [position, streamId] of rungIds.entries()) {
    await harness.published(streamId, last[position]);
    const write = [...harness.writes]
      .reverse()
      .find((candidate) => candidate.playlist.includes(`segment-${streamId}-${last[position]}`));
    assert.ok(write);
    playlists.set(streamId, entriesOf(write.playlist));
  }
  for (const labels of rows) {
    const placed = rungIds.map((streamId, position) => {
      const entry = playlists
        .get(streamId)!
        .find((candidate) => candidate.uri === `segment-${streamId}-${labels[position]}`);
      assert.ok(entry, `${streamId} must still list ${labels[position]}`);
      return entry;
    });
    const described = placed
      .map(
        (entry, position) =>
          `${RUNG_NAMES[position]} ${labels[position]} at ${entry.sequence}, ${new Date(entry.programDateTimeMs).toISOString()}`,
      )
      .join('; ');
    assert.deepEqual(
      placed.map((entry) => entry.sequence),
      placed.map(() => placed[0].sequence),
      `one cut at different sequences: ${described}`,
    );
    assert.deepEqual(
      placed.map((entry) => entry.programDateTimeMs),
      placed.map(() => placed[0].programDateTimeMs),
      `one cut dated differently: ${described}`,
    );
  }
}

/** The same label on every rung. */
function everyRung(label: string): string[] {
  return rungIds.map(() => label);
}

/** Run the ladder until 1080p, silent while its siblings publish, has been reaped into a recording. */
async function reaped1080(harness: RejoinHarness): Promise<number> {
  for (const streamId of rungIds) harness.start(streamId);
  for (let round = 0; round < 3; round++) {
    for (const streamId of rungIds) await harness.deliver(streamId, `a${round}`);
    await harness.passTime(SEGMENT_SECONDS * 1_000);
  }
  let round = 3;
  while (round * SEGMENT_SECONDS * 1_000 < REAP_MS + 4 * SEGMENT_SECONDS * 1_000) {
    for (const streamId of fastRungs) await harness.deliver(streamId, `a${round}`);
    await harness.passTime(SEGMENT_SECONDS * 1_000);
    round++;
  }
  await waitFor(
    () =>
      harness.writes.some(
        (write) => write.playlist.includes(VOD_TAG) && write.playlist.includes(`segment-${rung1080}-a0`),
      ),
    SETTLE_CEILING_MS,
  );
  return round;
}

/**
 * The rejoined 1080p delivers its first cut, and SRS bounces it again while the node is still answering
 * its feed head read, so its second cut arrives as a resumed run before the session knows where on its
 * feed it stands.
 *
 * @param untilPublished wait for 1080p's first playlist, which is after the head read has answered.
 * Without it the case carries on while the read is still answering.
 */
async function bouncedBeforeTheHeadRead(harness: RejoinHarness, untilPublished = true): Promise<void> {
  await reaped1080(harness);
  harness.start(rung1080);
  harness.restartCounter(rung1080);
  for (const streamId of fastRungs) await harness.deliver(streamId, 'x0');
  await harness.deliver(rung1080, 'x0');

  harness.orchestrator.noteDisconnect(rung1080);
  await harness.passTime(400);
  harness.start(rung1080);
  harness.restartCounter(rung1080);
  await harness.passTime(SEGMENT_SECONDS * 1_000 - 400);
  for (const streamId of fastRungs) await harness.deliver(streamId, 'x1');
  await harness.deliver(rung1080, 'x1');
  if (untilPublished) await harness.published(rung1080, 'x1');
}

describe('a rung rejoining a live ladder', () => {
  /**
   * ⛔ Measured by the review: the bounce resumed 1080p at its siblings' count in its own numbering, the
   * join then added its feed offset on top, and 1080p published 34 sequences and 68 seconds ahead of
   * its siblings for the rest of the broadcast, sealed into the recording.
   */
  it('stays on its siblings’ sequence and line when it is bounced again before its feed head read answers', async () => {
    const harness = rejoinHarness({ headReadMs: SLOW_HEAD_READ_MS });
    await bouncedBeforeTheHeadRead(harness);
    for (let cut = 2; cut < 5; cut++) {
      await harness.passTime(SEGMENT_SECONDS * 1_000);
      for (const streamId of rungIds) await harness.deliver(streamId, `x${cut}`);
    }
    await assertOneTimeline(harness, ['x0', 'x1', 'x2', 'x3', 'x4'].map(everyRung), everyRung('x4'));
  });

  it('comes back on one line with its siblings from a whole-ladder drop after that bounce', async () => {
    const harness = rejoinHarness({ headReadMs: SLOW_HEAD_READ_MS });
    await bouncedBeforeTheHeadRead(harness);
    for (let cut = 2; cut < 4; cut++) {
      await harness.passTime(SEGMENT_SECONDS * 1_000);
      for (const streamId of rungIds) await harness.deliver(streamId, `x${cut}`);
    }
    for (const streamId of rungIds) harness.orchestrator.noteDisconnect(streamId);
    await harness.passTime(10_000);
    for (const streamId of rungIds) harness.start(streamId);
    for (let cut = 0; cut < 3; cut++) {
      for (const streamId of rungIds) await harness.deliver(streamId, `y${cut}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    await assertOneTimeline(harness, ['x3', 'y0', 'y1', 'y2'].map(everyRung), everyRung('y2'));
  });

  /**
   * ⛔ A feed head read can take seconds, several slow reads in a row when bee's answer has to be probed
   * above, and a whole-ladder drop can land inside it. A rung that held back from the ladder until the
   * read answered placed its return at its own count with no line, and the read then re-dated it from
   * its first segment by media alone, which leaves the outage out: 1080p dated the return 8 seconds
   * before its siblings, found by review on 2026-10-15.
   */
  it('comes back on one line with its siblings from a whole-ladder drop that lands while its feed head read is answering', async () => {
    const harness = rejoinHarness({ headReadMs: SLOW_HEAD_READ_MS });
    await bouncedBeforeTheHeadRead(harness, false);
    for (let cut = 2; cut < 4; cut++) {
      await harness.passTime(SEGMENT_SECONDS * 1_000);
      for (const streamId of rungIds) await harness.deliver(streamId, `x${cut}`);
    }
    for (const streamId of rungIds) harness.orchestrator.noteDisconnect(streamId);
    await harness.passTime(10_000);
    for (const streamId of rungIds) harness.start(streamId);
    for (let cut = 0; cut < 3; cut++) {
      for (const streamId of rungIds) await harness.deliver(streamId, `y${cut}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    await assertOneTimeline(harness, ['x0', 'x1', 'x2', 'x3', 'y0', 'y1', 'y2'].map(everyRung), everyRung('y2'));
  });

  /**
   * ⛔ The ladder's record carries the epochs of every earlier return, written down in the siblings'
   * numbering. A rejoining session that kept them would count from 0 across them and land each time on
   * a line long past, so its join drops them. This case puts a return at sequence 3 and has the
   * rejoined rung count past it.
   */
  it('counts past an earlier return of its ladder without landing on that return’s line', async () => {
    const harness = rejoinHarness();
    for (const streamId of rungIds) harness.start(streamId);
    for (let round = 0; round < 3; round++) {
      for (const streamId of rungIds) await harness.deliver(streamId, `a${round}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    for (const streamId of rungIds) harness.orchestrator.noteDisconnect(streamId);
    await harness.passTime(10_000);
    for (const streamId of rungIds) harness.start(streamId);
    for (const streamId of rungIds) await harness.deliver(streamId, 'b0');
    await harness.passTime(SEGMENT_SECONDS * 1_000);

    let round = 1;
    while (round * SEGMENT_SECONDS * 1_000 < REAP_MS + 4 * SEGMENT_SECONDS * 1_000) {
      for (const streamId of fastRungs) await harness.deliver(streamId, `b${round}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
      round++;
    }
    await waitFor(
      () =>
        harness.writes.some(
          (write) => write.playlist.includes(VOD_TAG) && write.playlist.includes(`segment-${rung1080}-b0`),
        ),
      SETTLE_CEILING_MS,
    );

    harness.start(rung1080);
    harness.restartCounter(rung1080);
    const cuts = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5'];
    for (const cut of cuts) {
      await harness.deliver(rung1080, cut);
      for (const streamId of fastRungs) await harness.deliver(streamId, cut);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    await assertOneTimeline(harness, cuts.map(everyRung), everyRung('x5'));
  });
});

describe('a rung rejoining a live ladder whose first upload is lost', () => {
  /**
   * ⛔ The sequence a rejoining rung joins at was read when its first segment was handed over, and taken
   * by whichever segment landed first. Its first upload was refused, so its second landed first and
   * took the first one's sequence, a cut early on its siblings' line for the rest of the broadcast.
   */
  it('places the segment that lands first at the sequence of its own cut', async () => {
    const harness = rejoinHarness({ refusedLabels: new Set([`${rung1080}-x0`]) });
    await reaped1080(harness);
    harness.start(rung1080);
    harness.restartCounter(rung1080);
    for (const cut of ['x0', 'x1', 'x2', 'x3']) {
      for (const streamId of fastRungs) await harness.deliver(streamId, cut);
      await harness.deliver(rung1080, cut);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    await assertOneTimeline(harness, ['x1', 'x2', 'x3'].map(everyRung), everyRung('x3'));
  });
});

describe('a ladder opening on a declaration that already has a recording', () => {
  /**
   * ⛔ A rung announcing more than a fragment after its siblings' first cut found them with media, and
   * was taken for a rung rejoining a broadcast in progress, while their own numbering had not yet moved
   * past the recording already on their feeds. It took a sequence and a date in two different numberings
   * and dated the whole broadcast the previous recording's length away from its siblings.
   */
  it('dates a rung announcing after its siblings’ first cut on their line', async () => {
    const harness = rejoinHarness();
    for (const streamId of rungIds) harness.start(streamId);
    for (let round = 0; round < 3; round++) {
      for (const streamId of rungIds) await harness.deliver(streamId, `a${round}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    // Every rung goes silent, and the reaper ends the first broadcast as four recordings.
    await harness.passTime(REAP_MS + 5_000);
    await waitFor(
      () =>
        rungIds.every((streamId) =>
          harness.writes.some(
            (write) => write.playlist.includes(VOD_TAG) && write.playlist.includes(`segment-${streamId}-a2`),
          ),
        ),
      SETTLE_CEILING_MS,
    );
    await harness.passTime(30_000);

    // The second broadcast: three rungs announce and deliver one cut, 1080p announces 1.2 s later.
    for (const streamId of rungIds) harness.restartCounter(streamId);
    for (const streamId of fastRungs) harness.start(streamId);
    for (const streamId of fastRungs) await harness.deliver(streamId, 'x0');
    await harness.passTime(1_200);
    harness.start(rung1080);
    await harness.deliver(rung1080, 'x0');
    await harness.passTime(800);
    for (const cut of ['x1', 'x2']) {
      for (const streamId of rungIds) await harness.deliver(streamId, cut);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    await assertOneTimeline(harness, ['x0', 'x1', 'x2'].map(everyRung), everyRung('x2'));
  });
});

describe('a rung resuming in a partial return while behind on its uploads', () => {
  /**
   * ⛔ 360p comes back from its own drop while its siblings publish, and its first resumed segment lands
   * after it has already handed over its second. The return compared the siblings' newest hand-over
   * with 360p's newest rather than with the segment being placed, took that segment for its siblings'
   * newest cut, and resumed 360p a sequence high for the rest of the broadcast.
   */
  it('resumes it on the sequence of the cut it is placing, not of the cut it handed over last', async () => {
    const harness = rejoinHarness();
    const others = rungIds.slice(1);
    for (const streamId of rungIds) harness.start(streamId);
    for (let round = 0; round < 3; round++) {
      for (const streamId of rungIds) await harness.deliver(streamId, `a${round}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }
    harness.orchestrator.noteDisconnect(rung360);
    for (let round = 3; round < 6; round++) {
      for (const streamId of others) await harness.deliver(streamId, `a${round}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }

    // 360p's c0 is the cut its siblings deliver as a6, and c1 is a7. Its uploads are held behind.
    harness.start(rung360);
    const release = harness.hold(rung360);
    harness.handOver(rung360, 'c0');
    for (const streamId of others) await harness.deliver(streamId, 'a6');
    await harness.passTime(SEGMENT_SECONDS * 1_000);
    harness.handOver(rung360, 'c1');
    for (const streamId of others) await harness.deliver(streamId, 'a7');
    release();
    await harness.landed(rung360, 'c1');
    await harness.passTime(SEGMENT_SECONDS * 1_000);
    for (let cut = 2; cut < 4; cut++) {
      await harness.deliver(rung360, `c${cut}`);
      for (const streamId of others) await harness.deliver(streamId, `a${6 + cut}`);
      await harness.passTime(SEGMENT_SECONDS * 1_000);
    }

    const rows = [0, 1, 2, 3].map((cut) => [`c${cut}`, ...others.map(() => `a${6 + cut}`)]);
    await assertOneTimeline(harness, rows, ['c3', ...others.map(() => 'a9')]);
  });
});
