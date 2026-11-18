import {
  archivePauseNeedsDecision,
  type ArchiveActionRequest,
  type ArchiveBuyChoice,
  type ArchiveJobSummary,
  type ArchiveStartRequest,
} from '@streaming-monorepo/web2-admin-common';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { actOnArchive, confirmArchivePurchase, fetchCurrentArchive, startArchive } from '../../api';
import type { ArchiveContextValue, ArchivePanelState } from './archiveSeams';

/** While an archive is unfinished, it is read this often. */
export const ARCHIVE_POLL_ACTIVE_MS = 2_000;
/** Otherwise this often, so an archive another user starts shows up for everyone. */
export const ARCHIVE_POLL_IDLE_MS = 10_000;

const CLOSED: ArchivePanelState = { open: false, streamId: null, preselect: [] };

const nothing = async () => undefined;

/** Outside the provider, as a page rendered on its own is, there is no archive and opening the panel does nothing. */
const ArchiveContext = createContext<ArchiveContextValue>({
  current: null,
  panel: CLOSED,
  openPanel: () => undefined,
  closePanel: () => undefined,
  refresh: nothing,
  start: nothing,
  act: nothing,
  confirmPurchase: nothing,
});

export function useArchive(): ArchiveContextValue {
  return useContext(ArchiveContext);
}

const AWAITING = '@awaiting_purchase';

/**
 * The decision the panel comes to front for, for the user who started the archive, or null: a pause that asks for
 * one, told apart by the moment it paused, or a new stamp waiting to be confirmed.
 */
export function decisionKey(job: ArchiveJobSummary | null): string | null {
  if (!job || !job.startedByYou) return null;
  if (job.state === 'paused' && archivePauseNeedsDecision(job.pauseReason)) {
    return `${job.id}@paused@${job.pausedAt ?? ''}`;
  }
  if (job.state === 'awaiting_purchase') return `${job.id}${AWAITING}`;
  return null;
}

/**
 * The archive on the server, read every few seconds for as long as a user is signed in, and the panel's state, as
 * `ExportProvider` holds the export. One archive exists at a time for the whole admin, so every user's console shows
 * the same one. The reads on the timer are background reads, which leave the session's idle clock alone.
 *
 * When the archive pauses for a decision, or waits for a new stamp to be confirmed, the panel comes to front for the
 * user who started it, once each time. Everyone else sees the widget say it needs a decision.
 */
export function ArchiveProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ArchiveJobSummary | null>(null);
  const [panel, setPanel] = useState<ArchivePanelState>(CLOSED);
  const surfaced = useRef<string | null>(null);

  // A look on the timer is a background read: the operator did nothing, so it must not keep their session awake.
  const look = useCallback(async (background: boolean) => {
    try {
      setCurrent(await fetchCurrentArchive({ background }));
    } catch {
      // The next read tries again; a session that ended is the auth provider's to handle.
    }
  }, []);
  const refresh = useCallback(() => look(false), [look]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unfinished = current !== null && current.state !== 'done';
  useEffect(() => {
    const timer = setInterval(() => void look(true), unfinished ? ARCHIVE_POLL_ACTIVE_MS : ARCHIVE_POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [unfinished, look]);

  useEffect(() => {
    const key = decisionKey(current);
    if (key === null) {
      // The stamp was confirmed, or another was chosen: a later wait for a confirm comes to front again.
      if (surfaced.current?.endsWith(AWAITING)) surfaced.current = null;
      return;
    }
    if (surfaced.current === key) return;
    surfaced.current = key;
    setPanel({ open: true, streamId: null, preselect: [] });
  }, [current]);

  const openPanel = useCallback((streamId: string | null, preselect: readonly string[] = []) => {
    setPanel({ open: true, streamId, preselect: [...preselect] });
  }, []);
  const closePanel = useCallback(() => setPanel((was) => ({ ...was, open: false })), []);
  const start = useCallback(async (streamId: string, request: ArchiveStartRequest) => {
    setCurrent(await startArchive(streamId, request));
  }, []);
  const act = useCallback(
    async (request: ArchiveActionRequest) => {
      if (!current) return;
      try {
        setCurrent(await actOnArchive(current.id, request));
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [current, refresh],
  );
  const confirmPurchase = useCallback(
    async (jobId: string, choice: ArchiveBuyChoice) => {
      try {
        setCurrent(await confirmArchivePurchase(jobId, choice));
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh],
  );

  const value = useMemo<ArchiveContextValue>(
    () => ({ current, panel, openPanel, closePanel, refresh, start, act, confirmPurchase }),
    [current, panel, openPanel, closePanel, refresh, start, act, confirmPurchase],
  );
  return <ArchiveContext.Provider value={value}>{children}</ArchiveContext.Provider>;
}
