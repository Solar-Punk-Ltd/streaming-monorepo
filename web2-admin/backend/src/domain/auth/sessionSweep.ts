import { getErrorMessage } from '../../utils/errorUtils.js';
import { Logger } from '../Logger.js';

import type { AuthService } from './AuthService.js';

const logger = Logger.getInstance();

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionSweep {
  stop(): void;
}

/**
 * Deletes sessions that have run out, once now and once a day after that.
 *
 * Signing in prunes them too, so this is what keeps the table from holding
 * dead rows on a backend nobody has signed in to for a while. The timer is
 * unref'd: a daily sweep must never be the reason the process will not exit.
 */
export function startSessionSweep(
  authService: AuthService,
  intervalMs: number = DAY_MS,
): SessionSweep {
  const sweep = async (): Promise<void> => {
    try {
      const removed = await authService.deleteExpiredSessions();
      if (removed > 0) {
        logger.info(`[Auth] swept ${removed} expired session(s)`);
      }
    } catch (err) {
      logger.error('[Auth] session sweep failed:', getErrorMessage(err));
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
