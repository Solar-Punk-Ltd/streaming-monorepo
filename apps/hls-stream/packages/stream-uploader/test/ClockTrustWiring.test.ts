import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClockCheck } from '../src/libs/ClockCheck.js';
import { parseClockServers } from '../src/libs/sntp.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator, TEST_LIVE_WINDOW_MS } from './helpers/fakes.js';
import { videoSegment } from './helpers/transportStream.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

/**
 * The clock check's verdict reaching the live windows the way `index.ts` hands it over:
 * `clockTrusted: () => clockCheck.isTrusted()` on the orchestrator's config. A real `ClockCheck` judges
 * a round here, so this holds the two halves to one meaning of "trusted" rather than a test's own
 * boolean. The list notes take the same function through `StreamCatalog.startNotes`, and
 * `StreamCatalogNotes.test.ts` proves an untrusted answer skips the note.
 */

const SERVERS = parseClockServers('a.time.test');
const STREAM_ID = 'live/stream';
const WINDOWS_TO_WATCH = 10;
const SETTLE_CEILING_MS = 5_000;

/** A clock check that has finished one round against a server whose answer is `offsetMs` away. */
async function checkedClock(offsetMs: number): Promise<ClockCheck> {
  const check = new ClockCheck({
    servers: SERVERS,
    clock: new FakeClock(),
    query: async (server) => ({ server: server.host, offsetMs, delayMs: 4 }),
    logger: { info: () => {}, warn: () => {} },
  });
  check.start();
  await new Promise((resolve) => setImmediate(resolve));
  check.stop();
  return check;
}

/** Broadcasts two segments through an orchestrator wired to `check`, and counts the windows written. */
async function windowsWrittenUnder(check: ClockCheck): Promise<{ count: () => number; stop: () => Promise<void> }> {
  const windows: string[] = [];
  const orch = makeTestOrchestrator(
    { clockTrusted: () => check.isTrusted() },
    {
      uploadWindow: async (identifier) => {
        windows.push(identifier);
      },
    },
  );
  orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
  await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
  orch.handleSegment(STREAM_ID, 0, 2, videoSegment(2));
  orch.handleSegment(STREAM_ID, 1, 2, videoSegment(2));
  return { count: () => windows.length, stop: () => orch.cleanup() };
}

describe('the clock check decides whether a live window is written', () => {
  it('writes no live window while the check distrusts the clock', async () => {
    const check = await checkedClock(300);
    assert.equal(check.isTrusted(), false, 'the fixture was supposed to leave the clock untrusted');

    const broadcast = await windowsWrittenUnder(check);
    try {
      await waitAndConfirmNothingHappened(() => broadcast.count() === 0, WINDOWS_TO_WATCH * TEST_LIVE_WINDOW_MS);
      assert.equal(broadcast.count(), 0, 'a window dated by a distrusted clock would sit at the wrong address');
    } finally {
      await broadcast.stop();
    }
  });

  it('writes live windows once the check trusts the clock', async () => {
    const check = await checkedClock(10);
    assert.equal(check.isTrusted(), true);

    const broadcast = await windowsWrittenUnder(check);
    try {
      await waitFor(() => broadcast.count() > 0, SETTLE_CEILING_MS);
    } finally {
      await broadcast.stop();
    }
  });
});
