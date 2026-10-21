/**
 * The player's side of a page that comes back after it was hidden: whether to play a live stream again.
 *
 * An iPhone pauses the video when the phone locks and Safari does not resume it on unlock, so a live
 * viewer came back to a stopped player and had to start it by hand. The iOS Simulator
 * resumed by itself after 30 s and 2 min locks, so a return that finds playback running does nothing.
 *
 * A return only plays, it never seeks. The pause handler stopped loading, so hls.js's live sync
 * position is still worked out from the playlist read before the lock and would land a lock's length
 * behind live, or behind the playhead when the broadcast has stalled. Playing restarts loading through
 * the player's play handler, and hls.js moves the viewer to live itself once the playlist reloads.
 *
 * Which event an iPhone sends first on unlock, the pause or the page becoming visible, is not known.
 * So the rule records the viewer's own pauses rather than the system's: any pause it cannot show was
 * the viewer's, including one it never saw, is treated as the system's.
 */

/**
 * How close to a change of visibility a pause still counts as the system's, on either side.
 *
 * Safari can report the pause a moment before the page reports itself hidden, or queue it until after
 * the page is visible again. A viewer who pauses by hand and then locks the phone takes longer than
 * this, and so does one who pauses once the page is back.
 */
const SYSTEM_PAUSE_WINDOW_MS = 1000;

/** A pause the media element reported, on the same clock as the page's hidden time. */
interface PauseRecord {
  readonly atMs: number;
  readonly whilePageVisible: boolean;
}

/** What the rule reads off the page and the media element at the moment the page comes back. */
export interface ReturnSnapshot {
  readonly isLive: boolean;
  readonly isPaused: boolean;
  /** The last pause the element reported, or null when it reported none. */
  readonly lastPause: PauseRecord | null;
  /** When the page last went hidden, or null when it never has. */
  readonly hiddenAtMs: number | null;
}

/**
 * Whether a pause was the viewer's: made while the page was visible and more than a second before it
 * was hidden.
 *
 * A pause the viewer makes while the page is hidden, from the lock screen's controls, by taking out
 * earphones or with a media key, is indistinguishable here from the system's and is undone on return.
 */
export function isViewerPause(pause: PauseRecord, hiddenAtMs: number | null): boolean {
  if (!pause.whilePageVisible) {
    return false;
  }
  return hiddenAtMs === null || pause.atMs < hiddenAtMs - SYSTEM_PAUSE_WINDOW_MS;
}

/** Whether a returning player is played again or left as it is. A recording is never touched. */
export function decideOnReturn(snapshot: ReturnSnapshot): 'play' | 'leave' {
  if (!snapshot.isLive || !snapshot.isPaused) {
    return 'leave';
  }
  if (snapshot.lastPause !== null && isViewerPause(snapshot.lastPause, snapshot.hiddenAtMs)) {
    return 'leave';
  }
  return 'play';
}

/** Where the page says it was hidden and shown: `visibilitychange` on the document, `pagehide` and `pageshow` on the window. */
export interface ReturnPage {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Play a live stream again when the page comes back, unless the viewer paused it.
 *
 * @param isLive Read at the moment of deciding. The caller detaches this before it destroys hls.js,
 *   so it is never read from a destroyed instance.
 * @param reportPlayFailure Hears a refused `play()`, which a page without a user gesture can get.
 * @returns A detach that removes every listener this added.
 */
export function attachResumeOnReturn(
  media: HTMLMediaElement,
  page: ReturnPage,
  isLive: () => boolean,
  reportPlayFailure: (error: unknown) => void,
  now: () => number = () => performance.now(),
): () => void {
  let lastPause: PauseRecord | null = null;
  let hiddenAtMs: number | null = null;
  let shownAtMs: number | null = null;
  // A back-forward cache restore fires both `pageshow` and `visibilitychange`, and a refused play
  // leaves the element paused, so the second would play and report again.
  let isPlayPending = false;

  const play = (): void => {
    if (isPlayPending) {
      return;
    }
    isPlayPending = true;
    media
      .play()
      .catch(reportPlayFailure)
      .finally(() => {
        isPlayPending = false;
      });
  };

  const onPause = (): void => {
    const atMs = now();
    const whilePageVisible = page.document.visibilityState !== 'hidden';
    lastPause = { atMs, whilePageVisible };
    const isQueuedSystemPause = whilePageVisible && shownAtMs !== null && atMs - shownAtMs <= SYSTEM_PAUSE_WINDOW_MS;
    if (isQueuedSystemPause && isLive()) {
      shownAtMs = null;
      play();
    }
  };

  const onHidden = (): void => {
    hiddenAtMs = now();
    shownAtMs = null;
  };

  const onReturn = (): void => {
    shownAtMs ??= now();
    const decision = decideOnReturn({ isLive: isLive(), isPaused: media.paused, lastPause, hiddenAtMs });
    if (decision === 'play') {
      play();
    }
  };

  const onVisibilityChange = (): void => {
    if (page.document.visibilityState === 'hidden') {
      onHidden();
    } else {
      onReturn();
    }
  };
  const onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) {
      onReturn();
    }
  };

  media.addEventListener('pause', onPause);
  page.document.addEventListener('visibilitychange', onVisibilityChange);
  page.window.addEventListener('pagehide', onHidden);
  page.window.addEventListener('pageshow', onPageShow);

  return () => {
    media.removeEventListener('pause', onPause);
    page.document.removeEventListener('visibilitychange', onVisibilityChange);
    page.window.removeEventListener('pagehide', onHidden);
    page.window.removeEventListener('pageshow', onPageShow);
  };
}
