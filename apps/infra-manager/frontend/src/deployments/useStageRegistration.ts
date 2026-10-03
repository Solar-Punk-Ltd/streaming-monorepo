import { useEffect, useState } from 'react';

import type { StagePushState } from '@streaming-infra-manager/common';

import { fetchStageRegistration } from '../data';
import { NODE_REFRESH_INTERVAL_MS } from '../uploaders/beeReadiness';

/**
 * How the manager's last push of this deployment's stage record went, re-read
 * on the node readings' cadence. `undefined` until the first answer, and again
 * whenever the manager cannot be asked, so a line nobody could confirm is not
 * left on screen.
 *
 * @param name the deployment, or null for one that is no stage, which asks nothing.
 */
export function useStageRegistration(name: string | null): StagePushState | null | undefined {
  const [state, setState] = useState<StagePushState | null | undefined>(undefined);

  useEffect(() => {
    if (name === null) {
      setState(undefined);
      return undefined;
    }
    let current = true;
    const controller = new AbortController();
    const read = async () => {
      try {
        const answer = await fetchStageRegistration(name, controller.signal);
        if (current) setState(answer);
      } catch {
        if (current) setState(undefined);
      }
    };
    void read();
    const timer = setInterval(() => void read(), NODE_REFRESH_INTERVAL_MS);
    return () => {
      current = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [name]);

  return state;
}

/** The time now, moved on every second, for a line that says how long ago something was. */
export function useSecondsTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
