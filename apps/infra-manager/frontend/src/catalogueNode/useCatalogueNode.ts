import { useCallback, useEffect, useState } from 'react';

import { type CatalogueNodeAnswer, getErrorMessage } from '@streaming-infra-manager/common';

import { fetchCatalogueNode } from './catalogueNodeApi';

/** How often the card reads the designation again, for the batch's readings and the last push. */
export const CATALOGUE_NODE_POLL_MS = 10_000;

export interface CatalogueNodeLoad {
  /** The designation as last read, or null until the first answer. */
  answer: CatalogueNodeAnswer | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Takes a save's or a clear's answer, without another read. */
  replace: (answer: CatalogueNodeAnswer) => void;
}

/**
 * The brand's catalogue node, read when the page opens and, with `poll`, every ten seconds after. Off, it reads
 * nothing: a deployment page asks only for a node that could be the catalogue's.
 */
export function useCatalogueNode({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  const [answer, setAnswer] = useState<CatalogueNodeAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAnswer(await fetchCatalogueNode());
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    if (!poll) return undefined;
    const timer = setInterval(() => void reload(), CATALOGUE_NODE_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, poll, reload]);

  return { answer, error, reload, replace: setAnswer } satisfies CatalogueNodeLoad;
}
