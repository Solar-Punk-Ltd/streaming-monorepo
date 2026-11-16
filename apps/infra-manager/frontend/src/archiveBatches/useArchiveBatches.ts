import { useCallback, useEffect, useState } from 'react';

import { type ArchiveBatchesAnswer, getErrorMessage } from '@streaming-infra-manager/common';

import { fetchArchiveBatches } from './archiveBatchesApi';

/** How often the card reads the archive batches again, for their readings and the last push. */
export const ARCHIVE_BATCHES_POLL_MS = 10_000;

export interface ArchiveBatchesLoad {
  /** The archive batches as last read, or null until the first answer. */
  answer: ArchiveBatchesAnswer | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Takes an adopt's or a removal's answer, without another read. */
  replace: (answer: ArchiveBatchesAnswer) => void;
}

/**
 * The brand's archive batches, read when the page opens and, with `poll`, every ten seconds after. Off, it reads
 * nothing: a deployment page asks only for a node that could hold one.
 */
export function useArchiveBatches({
  enabled = true,
  poll = true,
}: { enabled?: boolean; poll?: boolean } = {}): ArchiveBatchesLoad {
  const [answer, setAnswer] = useState<ArchiveBatchesAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAnswer(await fetchArchiveBatches());
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    if (!poll) return undefined;
    const timer = setInterval(() => void reload(), ARCHIVE_BATCHES_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, poll, reload]);

  return { answer, error, reload, replace: setAnswer };
}
