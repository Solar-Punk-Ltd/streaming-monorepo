import { useCallback, useEffect, useRef, useState } from 'react';

import type { Source } from '@/swarm/sources';

import { checkSourceStatus, SOURCE_CHECK_INTERVAL_MS, type SourceStatus } from './sourceStatus';

type Catalog = { readonly owner: string; readonly topic: string };

/**
 * Each source's status while the node picker is open: every source checked as it opens and again
 * every {@link SOURCE_CHECK_INTERVAL_MS}, and nothing while it is closed. A check still running when the
 * picker closes, or when the sources change, is stopped, so a late answer cannot land on a source it was
 * not asked of.
 */
export function useSourceStatuses(
  sources: readonly Source[],
  isOpen: boolean,
  catalog: Catalog,
): { readonly statuses: Readonly<Record<string, SourceStatus>>; readonly recheck: (id: string) => void } {
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({});
  const controller = useRef<AbortController | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const watched = JSON.stringify(sources.map(({ id, type, url }) => [id, type, url]));

  const check = useCallback((source: Source, signal: AbortSignal) => {
    void checkSourceStatus(source, { catalog: catalogRef.current, signal }).then((status) => {
      if (!signal.aborted) {
        setStatuses((current) => ({ ...current, [source.id]: status }));
      }
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const running = new AbortController();
    controller.current = running;
    const checkAll = () => sourcesRef.current.forEach((source) => check(source, running.signal));
    checkAll();
    const timer = setInterval(checkAll, SOURCE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      running.abort();
      controller.current = null;
    };
  }, [isOpen, watched, check]);

  const recheck = useCallback(
    (id: string) => {
      const source = sourcesRef.current.find((candidate) => candidate.id === id);
      if (source && controller.current) {
        check(source, controller.current.signal);
      }
    },
    [check],
  );

  return { statuses, recheck };
}
