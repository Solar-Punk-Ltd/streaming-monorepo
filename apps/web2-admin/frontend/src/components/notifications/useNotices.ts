import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoticesView } from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';

/** The notices view as a page reads it: the view once read, why it could not be, and a way to read it again. */
export interface NoticesRead {
  view: NoticesView | null;
  error: string | null;
  load: () => void;
  /** Takes a write's answer, the whole view, as the view. */
  setView: (view: NoticesView) => void;
}

/**
 * Reads `GET /api/notifications` when the Notifications page or the Auto top-up tab mounts, and again on `load`. Only
 * the latest read is answered, and a write's answer, the whole view, replaces the view.
 */
export function useNotices(): NoticesRead {
  const [view, setView] = useState<NoticesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);

  const load = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    setError(null);
    api
      .fetchNotifications()
      .then((next) => {
        if (read === reads.current) setView(next);
      })
      .catch((e: unknown) => {
        if (read === reads.current) setError(errorMessage(e, 'The notices could not be read.'));
      });
  }, []);

  useEffect(load, [load]);

  const take = useCallback((next: NoticesView) => {
    reads.current += 1;
    setError(null);
    setView(next);
  }, []);

  return { view, error, load, setView: take };
}
