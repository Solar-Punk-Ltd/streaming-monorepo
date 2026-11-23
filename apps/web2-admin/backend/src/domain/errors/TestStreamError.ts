import { TEST_STREAM_REFUSALS, type TestStreamRefusedAction } from '@streaming-monorepo/web2-admin-common';

/**
 * Refuses an action a test stream never takes: a publish, an edit, an image or an archive. Its message is the sentence
 * the console shows.
 */
export class TestStreamError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly action: TestStreamRefusedAction,
  ) {
    super(TEST_STREAM_REFUSALS[action]);
    this.name = 'TestStreamError';
  }
}
