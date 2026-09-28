import {
  WATCH_VIEW_LOADING,
  WATCH_VIEW_NOT_STARTED,
  WATCH_VIEW_UNAVAILABLE,
  type WatchPageView,
} from '@/utils/watchPageView';

interface WatchPlaceholderProps {
  view: WatchPageView;
  /** The scheduled start, already worded for a person, or null when the entry names none. */
  startsAt: string | null;
}

/**
 * What the watch page says in place of the player, and nothing once the player is showing. A shared link opens
 * before the catalog has been read, and a first read over a cold gateway takes a while.
 */
export function WatchPlaceholder({ view, startsAt }: WatchPlaceholderProps) {
  if (view === WATCH_VIEW_LOADING) {
    return (
      <div className="stream-placeholder">
        <p>Loading this stream…</p>
      </div>
    );
  }
  if (view === WATCH_VIEW_NOT_STARTED) {
    return (
      <div className="stream-placeholder">
        <p>This stream has not started yet.</p>
        {startsAt && <p className="stream-placeholder-detail">Scheduled for {startsAt}</p>}
      </div>
    );
  }
  if (view === WATCH_VIEW_UNAVAILABLE) {
    return (
      <div className="stream-placeholder">
        <p>This stream is no longer available.</p>
      </div>
    );
  }
  return null;
}
