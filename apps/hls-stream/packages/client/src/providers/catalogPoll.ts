import { WATCH_VIEW_NOT_STARTED, WATCH_VIEW_UNAVAILABLE, WatchPageView } from '@/utils/watchPageView';

/**
 * How often a page that shows the catalog reads it again, in milliseconds.
 *
 * One number for every page that polls, and both read at the same pace: the browse page always, and
 * the watch page while what it shows depends on the catalog. Both use the same SWR key, so a viewer
 * moving between the two pages never has two polls running against the gateway.
 *
 * ⛔ **Once a minute, never faster.** Every read asks the list's next slot, which is not written yet,
 * and the next change to the list is written to exactly that slot. Bee skips each peer asked for an
 * address too early for a minute, and 25 to 40 early asks delayed a chat message by about 40 s, while a
 * few a minute were harmless. A browse page reading every 5 s made 12 such asks a minute per viewer. A
 * waiting watch page learns that its stream went live from the ladder's markers (see
 * `watchForLadderMarkers`), so this poll only carries a new or changed entry, a new start time or a
 * cancellation.
 *
 * ⛔ **It is also the wait after a read that failed.** A miss on the catalog's next slot is no longer
 * the 4ms it was when the gateway wrote the catalog itself: it takes about a second, with a tail past
 * six seconds, and some fail outright. SWR's default answer to a failure is to stop polling and back
 * off, which held an open page minutes behind, so `useCatalogPoll` retries after this same interval,
 * and the catalog reader reads a slot that timed out or was refused as nothing new rather than an
 * error.
 */
export const CATALOG_POLL_INTERVAL_MS = 60_000;

/**
 * How soon a failed read is tried again while the page has not shown the list from the source selected
 * now, in milliseconds.
 *
 * ⛔ **Only on a first load, the app's own or the first after a switch of node.** A viewer whose first
 * read fails would otherwise wait a whole {@link CATALOG_POLL_INTERVAL_MS} for the list. A retry asks
 * the list's next slot again, which is not written yet, and Bee skips each peer asked that early for a
 * minute, so once the list has been shown from that source a failed read waits the routine interval
 * instead.
 */
export const FIRST_LOAD_RETRY_MS = 5_000;

/**
 * How often the watch page has to read the catalog again, or null when it need not.
 *
 * ⛔ **Only a message the catalog can take back needs it.** The page decides to show "This stream has
 * not started yet" from the catalog entry's `state`, and without a poll the catalog is read once, when
 * the app loads. While it waits, the ladder's markers prompt the read that takes it live, and the poll
 * carries a new start time, a title change or a cancellation. A stream that was unpublished while the
 * page waited on it is read for too: publishing it again only reaches a page that is still reading.
 * Once the player is mounted it follows the stream's own feeds, and the page deliberately keeps no
 * catalog poll for that case, see `isStreamListLoaded` in `providers/App.tsx`.
 */
export function watchPageCatalogPollMs(view: WatchPageView): number | null {
  return view === WATCH_VIEW_NOT_STARTED || view === WATCH_VIEW_UNAVAILABLE ? CATALOG_POLL_INTERVAL_MS : null;
}
