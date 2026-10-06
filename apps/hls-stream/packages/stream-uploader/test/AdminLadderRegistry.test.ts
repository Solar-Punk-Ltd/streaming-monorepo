/**
 * The ladder registry admin mode uses: the admin holds the merge state.
 *
 * ## What each group of cases is for
 *
 * 1. **A rung's report goes to the admin, and what comes back decides the flip.** A rung can only ever
 *    see itself, so whether the ladder became a recording is read off the ladder the admin answers
 *    with. A failed report is a failed announce, which the uploader re-attempts on the catalog
 *    announce cadence.
 * 2. **The catalog is never touched.** The one rule admin mode has never been allowed to break. Here it
 *    is structural: this class holds no feed writer at all.
 * 3. **A rung that will not finish is judged here,** because the admin cannot be told of one.
 *
 * Every case drives a fake fetch under a real `AdminApiClient`, so what is asserted is this
 * deployment's own decision rather than a fixture's, except the one case about which recording names
 * the ladder, which hands the registry its answer directly. `AdminApiClient.test.ts` is where the wire
 * itself is driven.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient, RenditionReportResponse } from '../src/libs/AdminApiClient.js';
import { AdminLadderRegistry } from '../src/libs/AdminLadderRegistry.js';
import { LadderIdentity, RenditionAnnouncement } from '../src/libs/LadderRegistry.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const ADMIN_STREAM_ID = 'str_01HZY';
const DECLARED_TOPIC = 'declared-topic-0001';

const IDENTITY: LadderIdentity = {
  title: 'A declared broadcast',
  owner: '0xowner',
  group: DECLARED_TOPIC,
  mediatype: MEDIA_TYPE_VIDEO,
  adminStreamId: ADMIN_STREAM_ID,
};

const rung = (name: string, height: number, final?: { index: number; duration: number }): Rendition => ({
  name,
  width: (height * 16) / 9,
  height,
  topic: `topic-${name}`,
  bandwidth: 800_000,
  avgBandwidth: 700_000,
  ...(final ?? {}),
});

/** The merged ladder the admin answers with, what it says the ladder became, and the status it holds. */
function merged(
  renditions: Rendition[],
  ladder: Partial<RenditionReportResponse['ladder']> = {},
  status: string = 'live',
  feedIndex: number = 3,
): string {
  return JSON.stringify({
    stream: { id: ADMIN_STREAM_ID, status },
    renditions,
    ladder: { finished: false, flippedToFinished: false, duration: null, ...ladder },
    feed: { owner: '0xowner', topic: DECLARED_TOPIC, topicHex: '00', index: feedIndex, entryCount: 1 },
  });
}

interface Harness {
  registry: AdminLadderRegistry;
  /** Every url the admin client called, in order. */
  posted: string[];
}

interface HarnessOptions {
  /** What the admin answers for each report in turn. Defaults to a ladder holding just what was sent. */
  answer?: (rendition: Rendition, attempt: number) => Response | Promise<Response>;
}

function makeRegistry(options: HarnessOptions = {}): Harness {
  const posted: string[] = [];
  let attempts = 0;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    posted.push(String(input));
    const rendition = JSON.parse(String(init?.body)) as Rendition;
    attempts += 1;
    return options.answer?.(rendition, attempts) ?? new Response(merged([rendition]), { status: 200 });
  }) as typeof globalThis.fetch;

  return {
    registry: new AdminLadderRegistry({
      client: new AdminApiClient({
        baseUrl: ADMIN_URL,
        token: ADMIN_TOKEN,
        fetcher,
        // So a case about a refused report does not spend the retry ladder's four seconds of wall clock.
        sleep: async () => {},
      }),
    }),
    posted,
  };
}

describe('what a rendition announce does in admin mode', () => {
  it('reports the rung to the admin′s rendition route for the declared stream', async () => {
    const harness = makeRegistry();

    await harness.registry.upsertRendition(IDENTITY, rung('360p', 360));

    assert.deepEqual(harness.posted, [`${ADMIN_URL}/api/internal/streams/${ADMIN_STREAM_ID}/renditions`]);
  });

  it('hands back the flip and the ladder′s duration exactly as the admin reported them', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeRegistry({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: true, duration: 12 }), { status: 200 }),
    });

    const announced = await harness.registry.upsertRendition(IDENTITY, finished[0]);

    assert.deepEqual(announced, { recording: null, flippedToFinished: true, duration: 12 });
  });

  /**
   * The admin flips once, on the report that completed the merge. A report that reached the admin and
   * failed on this side afterwards loses that flip: the retry is answered with a finished ladder and
   * `flippedToFinished: false`. Read literally, that is a recording the admin lists as live for good,
   * so a finished ladder the admin still holds as anything but `vod` is a flip to report.
   */
  it('reports a finished ladder as flipped while the admin still holds the stream as live', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeRegistry({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: false, duration: 12 }, 'live'), {
          status: 200,
        }),
    });

    const announced = await harness.registry.upsertRendition(IDENTITY, finished[0]);

    assert.deepEqual(announced, { recording: null, flippedToFinished: true, duration: 12 });
  });

  it('does not report a finished ladder again once the admin holds the stream as vod', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeRegistry({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: false, duration: 12 }, 'vod'), {
          status: 200,
        }),
    });

    const announced = await harness.registry.upsertRendition(IDENTITY, finished[0]);

    assert.equal(
      announced.flippedToFinished,
      false,
      'a recovered rung re-announcing on a listed recording is not a second ending',
    );
  });

  /**
   * ⛔ The ladder's recording is its lowest finished rung's, which is what the stream list entry names
   * too, so the admin's `vod` and a standalone list point a viewer at the same recording. Answered
   * directly rather than through the client, whose contract does not yet read a rung named by its
   * recording alone.
   */
  it('names the ladder by its lowest finished rung′s recording', async () => {
    const recordingOf = (name: string) => name.repeat(64).slice(0, 64);
    const ladder: Rendition[] = [
      { ...rung('360p', 360), recording: recordingOf('a'), duration: 12 },
      { ...rung('720p', 720), recording: recordingOf('b'), duration: 12 },
    ];
    const client = {
      reportRendition: async (): Promise<RenditionReportResponse> => ({
        renditions: ladder,
        streamStatus: 'live',
        feedIndex: 4,
        ladder: { finished: true, flippedToFinished: true, duration: 12 },
      }),
    } as unknown as AdminApiClient;
    const registry = new AdminLadderRegistry({ client });

    const announced = await registry.upsertRendition(IDENTITY, ladder[1]);

    assert.deepEqual(announced, { recording: recordingOf('a'), flippedToFinished: true, duration: 12 });
  });

  /**
   * ⛔ A failed report has to cost what a failed catalog write costs, or the two deployments behave
   * differently at the one moment that decides whether a broadcast is findable at all. The uploader's
   * `announceToCatalog` catches this, records the age `/health` reports, and re-attempts on its own
   * cadence, and `completeFinalize` lets it propagate and leaves the recovery entry on disk.
   */
  it('throws when the admin refuses the report', async () => {
    const harness = makeRegistry({ answer: () => new Response('{"error":"invalid_state"}', { status: 409 }) });

    await assert.rejects(() => harness.registry.upsertRendition(IDENTITY, rung('360p', 360)), /admin API/);
  });

  it('throws when the admin answers 200 with a body that is not a ladder', async () => {
    const harness = makeRegistry({ answer: () => new Response('{"renditions":[{"name":"360p"}]}', { status: 200 }) });

    await assert.rejects(() => harness.registry.upsertRendition(IDENTITY, rung('360p', 360)), /admin API/);
  });

  /**
   * ⛔ Unreachable from the live path, since the engine resolves the declaration before anything starts
   * and the orchestrator refuses an announce without one, but said out loud rather than assumed,
   * because the alternative is a report addressed to `undefined` and a 404 that reads like a deleted
   * stream.
   */
  it('refuses to report a ladder that carries no admin stream id', async () => {
    const harness = makeRegistry();
    const { adminStreamId: _dropped, ...withoutId } = IDENTITY;

    await assert.rejects(() => harness.registry.upsertRendition(withoutId, rung('360p', 360)), /admin stream id/);
    assert.deepEqual(harness.posted, []);
  });
});

/**
 * ⛔⛔⛔ 2026-09-23, admin mode's half. The admin counts a ladder finished only when every rung it
 * holds has a recording, and its rendition route refuses any field it does not know, so a rung that
 * will not finish cannot be told to it. These pin what this side decides instead. The rungs here
 * finish with a feed index, which is what the admin answer's contract reads today.
 */
describe('a rung that will not finish, in admin mode', () => {
  const TOP_RUNG = rung('1080p', 1080);
  const THE_OTHER_THREE = [rung('360p', 360), rung('480p', 480), rung('720p', 720)];
  const finalOf = (live: Rendition, index: number): Rendition => ({ ...live, index, duration: 12 });

  /** The status the admin holds, which a case moves the way a `live` or `vod` report would. */
  interface AdminStatus {
    current: string;
  }

  interface MergingAdmin {
    answer: (rendition: Rendition) => Response;
    /** What a `live` report over a recording does to the ladder the admin holds: every index goes. */
    goLiveAgain: () => void;
  }

  /**
   * An admin that merges by its own rule: a report without an index keeps the index held for that rung,
   * the ladder is finished once every rung it holds has one, and the flip is judged against the ladder
   * before the report. Every answer carries the status the case says the admin holds.
   */
  function mergingAdmin(status: AdminStatus): MergingAdmin {
    const held = new Map<string, Rendition>();
    const isFinished = (ladder: Rendition[]) => ladder.length > 0 && ladder.every((r) => r.index !== undefined);
    const ladderNow = () => [...held.values()].sort((a, b) => a.height - b.height);
    let feedIndex = 0;

    return {
      answer: (rendition) => {
        const wasFinished = isFinished(ladderNow());
        const stored = held.get(rendition.name);
        held.set(
          rendition.name,
          rendition.index === undefined && stored?.index !== undefined
            ? { ...rendition, index: stored.index, duration: stored.duration }
            : rendition,
        );
        const ladder = ladderNow();
        const finished = isFinished(ladder);
        feedIndex += 1;
        return new Response(
          merged(
            ladder,
            { finished, flippedToFinished: finished && !wasFinished, duration: finished ? 12 : null },
            status.current,
            feedIndex,
          ),
          { status: 200 },
        );
      },
      goLiveAgain: () => {
        for (const [name, { index: _index, duration: _duration, ...live }] of held) {
          held.set(name, live);
        }
      },
    };
  }

  /** A registry over its own admin, with every rung of the ladder announced live. */
  async function liveLadder(status: AdminStatus): Promise<Harness & { admin: MergingAdmin }> {
    const admin = mergingAdmin(status);
    const harness = makeRegistry({ answer: (rendition) => admin.answer(rendition) });
    for (const live of [...THE_OTHER_THREE, TOP_RUNG]) {
      await harness.registry.upsertRendition(IDENTITY, live);
    }
    return { ...harness, admin };
  }

  async function finishTheOtherThree(
    registry: AdminLadderRegistry,
    firstIndex: number,
  ): Promise<RenditionAnnouncement[]> {
    const announces: RenditionAnnouncement[] = [];
    for (const [at, live] of THE_OTHER_THREE.entries()) {
      announces.push(await registry.upsertRendition(IDENTITY, finalOf(live, firstIndex + at)));
    }
    return announces;
  }

  it('finishes the ladder on the last sibling′s final report when the rung was marked first', async () => {
    const harness = await liveLadder({ current: 'live' });
    await harness.registry.recordRungUnfinished(IDENTITY, TOP_RUNG);

    const announces = await finishTheOtherThree(harness.registry, 7);

    assert.deepEqual(
      announces.map((announced) => announced.flippedToFinished),
      [false, false, true],
      'the ladder became a recording when the last of the three finished, and only then',
    );
    assert.equal(announces[2].duration, 12, 'the recording′s playing time, from the rungs that recorded it');
  });

  it('finishes the ladder on the mark itself when the siblings finished first', async () => {
    const harness = await liveLadder({ current: 'live' });
    await finishTheOtherThree(harness.registry, 7);

    const announced = await harness.registry.recordRungUnfinished(IDENTITY, TOP_RUNG);

    assert.equal(announced.flippedToFinished, true);
  });

  /**
   * ⛔ Scenario H in admin mode. A rung recovered at the next boot announces without a recording before
   * it finalizes, in a process that holds no mark. The admin's `vod` is the one record that survived.
   */
  it('reports no second ending when a recovered rung re-announces on a recording the admin holds', async () => {
    const status = { current: 'live' };
    const before = await liveLadder(status);
    await before.registry.recordRungUnfinished(IDENTITY, TOP_RUNG);
    await finishTheOtherThree(before.registry, 7);
    status.current = 'vod';

    // The reboot: the admin still holds the merge and the recording, and this process holds nothing.
    const after = makeRegistry({ answer: (rendition) => before.admin.answer(rendition) });
    const announced = await after.registry.upsertRendition(IDENTITY, TOP_RUNG);

    assert.equal(announced.flippedToFinished, false, 'a recovered rung re-announcing is not a second ending');
  });

  it('reports no second ending when the rung finishes after all', async () => {
    const status = { current: 'live' };
    const harness = await liveLadder(status);
    await harness.registry.recordRungUnfinished(IDENTITY, TOP_RUNG);
    await finishTheOtherThree(harness.registry, 7);
    status.current = 'vod';

    const announced = await harness.registry.upsertRendition(IDENTITY, finalOf(TOP_RUNG, 20));

    assert.equal(
      announced.flippedToFinished,
      false,
      'the admin′s own merge finishes here for the first time, and the broadcast still ended only once',
    );
  });

  /**
   * A declared stream is one ladder for many broadcasts, and the mark is about one of them. Kept into the
   * next, that broadcast would be listed as a recording before its own 1080p had finished.
   */
  it('forgets the mark once the admin holds the recording, so the next broadcast waits for its own rungs', async () => {
    const status = { current: 'live' };
    const harness = await liveLadder(status);
    await harness.registry.recordRungUnfinished(IDENTITY, TOP_RUNG);
    await finishTheOtherThree(harness.registry, 7);

    // The next broadcast's first announce lands while the admin still holds the last one's recording,
    // then its `live` report clears every index the admin holds.
    status.current = 'vod';
    await harness.registry.upsertRendition(IDENTITY, TOP_RUNG);
    status.current = 'live';
    harness.admin.goLiveAgain();

    const announces = await finishTheOtherThree(harness.registry, 30);

    assert.ok(
      announces.every((announced) => !announced.flippedToFinished),
      'the next broadcast was listed as a recording while its 1080p was still live',
    );
  });
});
