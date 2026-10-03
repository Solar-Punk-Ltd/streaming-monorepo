import { useEffect, useState } from 'react';

import { type ConsoleStage, getErrorMessage } from '@streaming-infra-manager/common';

import { fetchConsoleStages } from '../data';
import { STAGES_REFRESH_MS } from './stagesView';

export interface ConsoleStagesLoad {
  /** The stages as last read, or null until the first answer. */
  stages: ConsoleStage[] | null;
  /** When that answer arrived, ISO 8601, or null before any. */
  readAt: string | null;
  /** Why the last read failed, or null once one succeeds. */
  error: string | null;
  /** Reads them again now, with the last failure cleared, and starts the cadence over from there. */
  reload: () => void;
}

/**
 * Every stage of this manager, from `GET /stages`, read when the page opens and every 30 seconds after. A read that
 * fails keeps the last answer and says why; the page says how old that answer is. A read is not started while the one
 * before it is still out, and one that outlives the page, or a reload, is dropped.
 */
export function useConsoleStages(): ConsoleStagesLoad {
  const [stages, setStages] = useState<ConsoleStage[] | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    let reading = false;
    const controller = new AbortController();
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const answer = await fetchConsoleStages(controller.signal);
        if (!current) return;
        setStages(answer);
        setReadAt(new Date().toISOString());
        setError(null);
      } catch (caught) {
        if (current) setError(getErrorMessage(caught, 'failed to read the stages'));
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), STAGES_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [attempt]);

  const reload = () => {
    setError(null);
    setAttempt((count) => count + 1);
  };

  return { stages, readAt, error, reload };
}
