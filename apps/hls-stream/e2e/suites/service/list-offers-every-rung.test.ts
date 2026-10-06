import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { type CatalogEntry, discoverCatalogFeed, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service: the stream list offers every rung a viewer joining now could choose.
 *
 * ## Where the ladder is now
 *
 * No master playlist is published any more. A ladder's entry in the stream list names every rung
 * under `renditions`, each with its topic, its size and its measured bandwidth, and a player builds
 * the master from that. So the question this suite used to ask of the master feed, whether a viewer
 * joining mid-broadcast is offered the whole ladder, is asked of the list entry instead.
 *
 * `abr-ladder` still owns whether the ladder came up, off the uploader's log, and this owns whether
 * the list offers what came up. `pnpm e2e:ladder-restored` runs both, in that order.
 *
 * ## What changed for a stage with a drained batch
 *
 * The master used to drop a rung within seconds of its batch running dry, so this suite skipped on a
 * stage still armed for a drain. The list keeps a rung until the broadcast ends and the player drops a
 * rung whose windows stop arriving, so an armed stage offers every rung here too and nothing skips.
 *
 * ## What this asserts, and what stays an observation
 *
 * That the entry carrying this broadcast's rungs offers exactly the rung topics its announces name,
 * each with a size and a bandwidth above zero, and points a client that knows nothing of renditions
 * at the lowest rung. Nothing about how long the list took: the wait's ceiling is the harness's
 * patience, never a threshold on the product.
 *
 * ⛔ Requires a deployed profile and funded stamps, like every suite under `suites/`. Nothing in CI
 * runs these.
 */

/**
 * How long the ladder gets to announce every rung, and then the list to name them. A ceiling on the
 * harness, never a threshold on the product.
 */
const LADDER_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('service: the stream list offers every rung of the ladder', { skip: abrOff(cfg.abrEnabled) }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

  it('names every rung this broadcast announced, so a viewer joining now is offered the whole ladder', async () => {
    const expected = cfg.abrRungs.length;
    assert.ok(
      expected > 1,
      'ABR_LADDER names fewer than two rungs, so this asserts nothing: set it explicitly rather ' +
        'than leaving the engine to its default, which this suite cannot see',
    );

    // ⛔ The configured count first, so this does not pass by holding the list against a ladder that
    // came up short. Which rungs those are is `abr-ladder`'s own assertion.
    await waitFor(async () => announcedTopicsOf(await log()).size >= expected, {
      timeoutMs: LADDER_WAIT_MS,
      intervalMs: 3_000,
      label:
        `all ${expected} rungs announce before the list is read. A rung missing here is one the list ` +
        'is right not to offer, so pnpm e2e:abr-ladder is the suite that explains it',
    });

    const announced = announcedTopicsOf(await log());
    const feed = await discoverCatalogFeed(host, cfg);
    console.log(`  this broadcast announced ${[...announced.values()].join(', ')}`);

    let entry: CatalogEntry | undefined;
    await waitFor(
      async () => {
        entry = ladderEntryOf(await fetchCatalog(host, cfg, feed), announced);
        return entry !== undefined && offeredTopics(entry).size === announced.size;
      },
      {
        timeoutMs: LADDER_WAIT_MS,
        intervalMs: 3_000,
        label: `the list entry of this ladder offers all ${announced.size} announced rungs`,
      },
    );

    assert.ok(entry !== undefined, 'no list entry carries this broadcast');
    assert.deepEqual(
      [...offeredTopics(entry)].sort(),
      [...announced.keys()].sort(),
      'the entry offers rungs other than the ones this broadcast announced',
    );
    for (const rendition of entry.renditions ?? []) {
      assert.ok((rendition.width ?? 0) > 0 && (rendition.height ?? 0) > 0, `${rendition.name} carries no size`);
      assert.ok((rendition.bandwidth ?? 0) > 0, `${rendition.name} carries no bandwidth to choose it by`);
    }
    assert.equal(
      entry.topic,
      entry.renditions?.[0]?.topic,
      'the entry points a client that reads no renditions at the lowest rung',
    );
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder for the list to offer';
}

/** Every rung this window announced, by its topic, which is how a list entry's renditions are joined. */
function announcedTopicsOf(logText: string): ReadonlyMap<string, string> {
  return new Map(announcedRungs(logText).map((announce) => [announce.topic, announce.rung]));
}

/** The entry naming any of this broadcast's rung topics, so a co-tenant's ladder is never read. */
function ladderEntryOf(
  entries: readonly CatalogEntry[],
  announced: ReadonlyMap<string, string>,
): CatalogEntry | undefined {
  return entries.find((entry) => (entry.renditions ?? []).some((rendition) => announced.has(rendition.topic)));
}

function offeredTopics(entry: CatalogEntry): ReadonlySet<string> {
  return new Set((entry.renditions ?? []).map((rendition) => rendition.topic));
}
