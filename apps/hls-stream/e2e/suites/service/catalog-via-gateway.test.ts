import {
  isHeartbeatWindow,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  windowEnd,
  windowOf,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import {
  type CatalogEntry,
  type CatalogFeed,
  discoverCatalogFeed,
  fetchCatalog,
  fetchCatalogAt,
  fetchListNote,
} from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Service — the stream catalog a VIEWER loads (resolved through the bee-gateway) reflects the
 * live→VOD lifecycle. This is the player-visible layer: the same `GET /feeds/{owner}/{topic}` the
 * client's StreamBrowser makes. A fresh publish must surface a new `live` entry, and a clean stop
 * must flip that same entry to `vod` with a real duration.
 *
 * The list is written direct and then named in a note, in 10 s windows with a heartbeat every
 * minute. Once the entry says `vod`, a heartbeat note must name a version of the list that carries
 * it, which is what a viewer on the notes reads instead of polling the next feed index.
 */

// Generous on purpose: the gateway's feed lookup can still lag the write it reports, so these are an
// accepted propagation budget, not a behavioural expectation.
const APPEAR_WAIT_MS = 300_000;
const VOD_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

/**
 * How long after a window's end it is first asked. Never earlier: an ask before the note exists makes
 * Bee skip its peers for that address for about a minute.
 */
const NOTE_READ_MARGIN_MS = 2_000;

/** Heartbeat windows asked, each once, before the notes count as missing. */
const HEARTBEAT_WINDOWS_ASKED = 3;

const cfg = loadConfig();

describe('service — viewer catalog via gateway reflects live→VOD', () => {
  const host = makeHost(cfg);
  let publisher: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;
  let ourTopic: string | undefined;
  let vodSeenAt: number | undefined;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return []; // transient feed-resolution blip — treated as "not ready yet" by the pollers
    }
  };

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    // Deliberately NOT the swallowing `safeFetch`. A failed read here yields an empty baseline, and
    // an empty baseline makes every entry look new — including the previous scenario's, which is
    // still `live` on the gateway because these suites run serially and that catalog lags by
    // minutes. The wait below would then latch onto a stream this test never published. The read
    // carries an 8s deadline while these tests budget 300s for the gateway, so it timing out is the
    // ordinary case rather than an exotic one. On the polls `safeFetch` stays, because there "not
    // ready yet" is a real answer.
    baselineTopics = new Set((await fetchCatalog(host, cfg, feed)).map((e) => e.topic));
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('surfaces a new live entry, then flips it to VOD on a clean stop', async () => {
    await waitFor(
      async () => {
        const mine = (await safeFetch()).find((e) => !baselineTopics.has(e.topic) && e.state === 'live');
        if (mine) {
          ourTopic = mine.topic;
        }
        return mine !== undefined;
      },
      { timeoutMs: APPEAR_WAIT_MS, intervalMs: 3_000, label: 'a new live entry appears in the gateway-served catalog' },
    );
    assert.ok(ourTopic, 'expected to capture the new stream topic');

    await publisher.stop();

    // ⛔ The entry is KEPT from inside the poll, the way `ourTopic` is above, rather than re-read
    // once the wait has passed. `safeFetch` swallows a failed read into an empty list, which is the
    // right answer for a poller and the wrong one for a verdict: one transient blip on that last
    // read would fail a scenario that had already succeeded, and name the feed transport rather
    // than the product. What the assertions below judge is the last state the poll actually saw.
    let finalEntry: CatalogEntry | undefined;
    await waitFor(
      async () => {
        const mine = (await safeFetch()).find((e) => e.topic === ourTopic);
        if (mine?.state === 'vod') {
          finalEntry = mine;
          vodSeenAt = Date.now();
        }
        return finalEntry !== undefined;
      },
      {
        timeoutMs: VOD_WAIT_MS,
        intervalMs: 3_000,
        label: 'our catalog entry flips to VOD after the broadcaster stops',
      },
    );

    assert.equal(finalEntry?.state, 'vod', 'the entry must end as VOD');
    assert.ok(
      (finalEntry?.duration ?? 0) > 0,
      `a VOD entry must carry a positive duration; got ${finalEntry?.duration}`,
    );
    assert.equal(finalEntry?.owner, feed.owner, 'the entry owner must match the catalog feed owner');
  });

  it('names a version carrying the recording in a heartbeat note of the list', async () => {
    assert.ok(
      ourTopic !== undefined && vodSeenAt !== undefined,
      'the entry never reached vod, so there is nothing to name',
    );

    // A heartbeat window that starts after the vod entry was seen names a version at least that new.
    const ratio = STREAM_LIST_HEARTBEAT_MS / STREAM_LIST_NOTE_WINDOW_MS;
    let window = windowOf(vodSeenAt, STREAM_LIST_NOTE_WINDOW_MS) + 1;
    const asked: number[] = [];
    let found: { window: number; newest: number; writtenAt: number } | undefined;
    while (asked.length < HEARTBEAT_WINDOWS_ASKED && found === undefined) {
      while (!isHeartbeatWindow(window, STREAM_LIST_NOTE_WINDOW_MS, STREAM_LIST_HEARTBEAT_MS)) {
        window += 1;
      }
      await sleep(Math.max(0, windowEnd(window, STREAM_LIST_NOTE_WINDOW_MS) + NOTE_READ_MARGIN_MS - Date.now()));
      asked.push(window);
      const note = await fetchListNote(host, cfg, feed, window).catch(() => null);
      if (note !== null) {
        found = { window, ...note };
      }
      window += ratio;
    }
    assert.ok(found, `no note in heartbeat windows ${asked.join(', ')} of the stream list`);
    assert.ok(found.newest >= 0, `the heartbeat named no version at all (newest ${found.newest})`);

    const version = await fetchCatalogAt(host, cfg, feed, found.newest);
    const mine = version.find((e) => e.topic === ourTopic);
    assert.equal(mine?.state, 'vod', `the version at index ${found.newest} the note names must list the recording`);

    console.log(
      `  observations, none of them asserted. heartbeat window ${found.window} named index ${found.newest}, ` +
        `written ${found.writtenAt - windowEnd(found.window, STREAM_LIST_NOTE_WINDOW_MS)} ms after its end, ` +
        `${asked.length} window(s) asked`,
    );
  });
});
