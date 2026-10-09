import { useEffect, useRef } from 'react';
import useSWR, { SWRConfiguration } from 'swr';

import { useAppContext } from '@/providers/App';
import { FIRST_LOAD_RETRY_MS } from '@/providers/catalogPoll';

/** How the latest read of the catalog went, for a page that says so. */
interface CatalogPollState {
  error: unknown;
  isLoading: boolean;
}

/**
 * Reads the catalog again every `pollMs` and hands each answer to the app's stream list.
 *
 * Both pages that poll the catalog come through here, the browse page always and the watch page while
 * its stream has not started or was unpublished while it waited, so they share one SWR key and one
 * poll rather than running two against the gateway. The source is part of the key so that a switch
 * starts a fresh fetch rather than inheriting the previous node's answer: `isLoading` is then true
 * again while the new node is being asked, and an `error` belongs to the node now selected instead of
 * the one the viewer has left.
 *
 * ⛔ **A failed read is followed by the next one at the same cadence, never by a backoff.** Until the
 * list has been shown once, the next one comes after {@link FIRST_LOAD_RETRY_MS} instead, so a first
 * read that fails does not leave the page empty for a whole interval. SWR skips
 * its refresh timer while its cache holds an error and leaves the next read to `onErrorRetry`, whose
 * default waits longer after every failure, from 5 to 10 s after one up to minutes after a few in a
 * row. One slow or refused read used to hold an open page that far behind, so a stream published or
 * gone live reached it only after a reload. A retry is scheduled only while the page is visible, which
 * is SWR's own rule, and is dropped if the page has been hidden by the time it is due, since SWR reads
 * again when the page is shown.
 *
 * @param pollMs How often to read, or null not to read at all, which is SWR's null key.
 */
export function useCatalogPoll(pollMs: number | null): CatalogPollState {
  const { fetchAppState, setNewStreamList, streamListSourceId } = useAppContext();
  const hasShownList = useRef(false);
  const { data, error, isLoading } = useSWR(pollMs === null ? null : ['app-state', streamListSourceId], fetchAppState, {
    revalidateOnFocus: true,
    refreshInterval: pollMs ?? 0,
    dedupingInterval: pollMs ?? 0,
    shouldRetryOnError: true,
    onErrorRetry: retryAfter(pollMs, () => hasShownList.current),
  });

  useEffect(() => {
    if (data) {
      hasShownList.current = true;
      setNewStreamList(data);
    }
  }, [data, setNewStreamList]);

  return { error, isLoading };
}

/**
 * SWR's error retry, flat: the next read comes a fixed time after a failure, however many came before
 * it. That time is {@link FIRST_LOAD_RETRY_MS} while the page has never shown the list, and `pollMs`
 * once it has.
 */
function retryAfter(pollMs: number | null, hasShownList: () => boolean): SWRConfiguration['onErrorRetry'] {
  return (_error, _key, config, revalidate, options) => {
    if (pollMs === null) {
      return;
    }
    const waitMs = hasShownList() ? pollMs : Math.min(pollMs, FIRST_LOAD_RETRY_MS);
    setTimeout(() => {
      if (config.isVisible()) {
        void revalidate(options);
      }
    }, waitMs);
  };
}
