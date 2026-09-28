import { getErrorMessage } from '../utils/errorUtils.js';

import { Logger } from './Logger.js';
import type { FeedBootCheck, PublishService } from './PublishService.js';

const logger = Logger.getInstance();

/**
 * Runs the boot's feed check once, when there is a node to run it against.
 *
 * The check reads the feed head through the catalogue node, which the manager names in the catalogue stamp it
 * pushes. An admin deployed before the manager designated a batch has none at boot, so the check is skipped with a
 * warning and runs as soon as a push stores a designation. It runs once per process either way: a check that failed
 * is logged and not retried, as before there was a catalogue stamp.
 */
export class FeedBootCheckRunner {
  private state: 'waiting' | 'running' | 'done' = 'waiting';
  /** A designation stored while a check that is about to be skipped was running. */
  private storedWhileRunning = false;

  constructor(private readonly publish: Pick<PublishService, 'checkFeedOnBoot'>) {}

  /** At boot. Never throws: the API is fully usable whatever the check finds, or whether it ran. */
  async run(): Promise<FeedBootCheck | null> {
    if (this.state !== 'waiting') return null;
    this.state = 'running';
    this.storedWhileRunning = false;

    let check: FeedBootCheck;
    try {
      check = await this.publish.checkFeedOnBoot();
    } catch (error) {
      this.state = 'done';
      logger.warn(`[Boot] feed check failed: ${getErrorMessage(error)}`);
      return null;
    }

    if (check.skipped !== null) {
      this.state = 'waiting';
      logger.warn(`[Boot] feed check skipped until the manager designates a catalogue batch: ${check.skipped}`);
      if (this.storedWhileRunning) return this.run();
      return check;
    }

    this.state = 'done';
    logger.info(
      `[Boot] feed: last write recorded ${check.recorded ?? 'none'}, network head ${check.network ?? 'none'}${check.adopted ? ' (adopted)' : ''}`,
    );
    return check;
  }

  /**
   * After a push stored a designation: runs the check while it still waits for one. The caller does not wait for
   * it, since the push's answer does not depend on it; the promise is there for a test to.
   */
  async catalogueStampStored(): Promise<FeedBootCheck | null> {
    if (this.state === 'running') {
      this.storedWhileRunning = true;
      return null;
    }
    return this.run();
  }
}
