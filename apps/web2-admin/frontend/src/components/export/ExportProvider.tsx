import {
  EXPORT_ACTIVE_STATES,
  pauseNeedsDecision,
  type ExportAction,
  type ExportSummary,
} from '@streaming-monorepo/web2-admin-common';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { actOnExport, fetchCurrentExport, startExport } from '../../api';

/** While an export runs, its progress is read this often. */
export const EXPORT_POLL_ACTIVE_MS = 2_000;
/** Otherwise this often, so an export another user starts shows up for everyone. */
export const EXPORT_POLL_IDLE_MS = 10_000;

/**
 * The Download panel: opened for a stream, from its page, to choose a quality; or for the export on the server, from
 * the widget, with `streamId` null.
 */
export interface ExportPanelState {
  open: boolean;
  streamId: string | null;
}

export interface ExportContextValue {
  /** The export on the server, which every signed-in user sees, or null. */
  current: ExportSummary | null;
  panel: ExportPanelState;
  openPanel: (streamId: string | null) => void;
  closePanel: () => void;
  refresh: () => Promise<void>;
  start: (streamId: string, rendition: string) => Promise<void>;
  act: (action: ExportAction) => Promise<void>;
}

const nothing = async () => undefined;

/** Outside the provider, as a page rendered on its own is, there is no export and opening the panel does nothing. */
const ExportContext = createContext<ExportContextValue>({
  current: null,
  panel: { open: false, streamId: null },
  openPanel: () => undefined,
  closePanel: () => undefined,
  refresh: nothing,
  start: nothing,
  act: nothing,
});

export function useExport(): ExportContextValue {
  return useContext(ExportContext);
}

/**
 * The export on the server, read every few seconds for as long as a user is signed in, and the panel's state. One
 * export exists at a time for the whole admin, so every user's console shows the same one. The reads on the timer
 * are background reads, which leave the session's idle clock alone, so an open console still signs out when idle.
 *
 * When the export pauses for a decision, on segments that cannot be read, a stream that went live again, a full
 * disk or another problem, the panel comes to front for the user who started it, once per pause. Everyone else sees
 * the widget say it needs a decision.
 */
export function ExportProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ExportSummary | null>(null);
  const [panel, setPanel] = useState<ExportPanelState>({ open: false, streamId: null });
  const surfaced = useRef<string | null>(null);

  // A look on the timer is a background read: the operator did nothing, so it must not keep their session awake.
  const look = useCallback(async (background: boolean) => {
    try {
      setCurrent(await fetchCurrentExport({ background }));
    } catch {
      // The next read tries again; a session that ended is the auth provider's to handle.
    }
  }, []);
  const refresh = useCallback(() => look(false), [look]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = current !== null && EXPORT_ACTIVE_STATES.includes(current.state);
  useEffect(() => {
    const timer = setInterval(() => void look(true), active ? EXPORT_POLL_ACTIVE_MS : EXPORT_POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [active, look]);

  useEffect(() => {
    if (!current || current.state !== 'paused' || !current.startedByYou || !pauseNeedsDecision(current.pauseReason)) {
      return;
    }
    const pause = `${current.id}@${current.pausedAt ?? ''}`;
    if (surfaced.current === pause) return;
    surfaced.current = pause;
    setPanel({ open: true, streamId: null });
  }, [current]);

  const openPanel = useCallback((streamId: string | null) => setPanel({ open: true, streamId }), []);
  const closePanel = useCallback(() => setPanel((was) => ({ ...was, open: false })), []);
  const start = useCallback(async (streamId: string, rendition: string) => {
    setCurrent(await startExport(streamId, rendition));
  }, []);
  const act = useCallback(
    async (action: ExportAction) => {
      if (!current) return;
      try {
        setCurrent(await actOnExport(current.id, action));
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [current, refresh],
  );

  const value = useMemo<ExportContextValue>(
    () => ({ current, panel, openPanel, closePanel, refresh, start, act }),
    [current, panel, openPanel, closePanel, refresh, start, act],
  );
  return <ExportContext.Provider value={value}>{children}</ExportContext.Provider>;
}
