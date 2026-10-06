import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../src/libs/Logger.js';
import { RECOVERY_ENTRY_LOADED, StreamState } from '../src/types.js';

import { makeFakeRecoveryStore, makeTestOrchestrator, toRecoveryFileId } from './helpers/fakes.js';
import { makeRecoveredState } from './helpers/recoveredState.js';

/**
 * A recovery entry written by the uploader that published on feeds, before live windows.
 *
 * Its numbering is a feed index and its glued prefix came off a feed head, neither of which this
 * uploader writes or reads. It is not rebuilt: the entry is dropped with one line and the stream id is
 * free for a fresh broadcast. the owner's ruling of 2026-10-06, no path built around the old design.
 */
describe('a recovery entry from the uploader on feeds', () => {
  const PRE_WINDOW = 'live/pre-window';

  function preWindowEntry(): StreamState {
    return { ...makeRecoveredState(PRE_WINDOW), socIndex: 5 } as StreamState;
  }

  it('is dropped with one line rather than recovered', async () => {
    const removed: string[] = [];
    const lines: string[] = [];
    const store = makeFakeRecoveryStore({
      listActive: () => [toRecoveryFileId(PRE_WINDOW)],
      read: () => ({ kind: RECOVERY_ENTRY_LOADED, state: preWindowEntry() }),
      remove: (fileId: string) => removed.push(fileId),
    });
    const orch = makeTestOrchestrator({}, {}, store);
    const logger = Logger.getInstance();
    const previous = logger.configure({ sink: (_level, line) => void lines.push(line) });

    try {
      const recovered = await orch.recoverStreams();

      assert.deepEqual(recovered, [], 'an entry from the old design is not rebuilt');
      assert.equal(orch.getActiveStreamCount(), 0);
      assert.deepEqual(removed, [toRecoveryFileId(PRE_WINDOW)], 'and it is dropped, so no later boot meets it again');
      assert.equal(lines.filter((line) => line.includes('written before live windows')).length, 1);
    } finally {
      logger.configure(previous);
      await orch.cleanup();
    }
  });
});
