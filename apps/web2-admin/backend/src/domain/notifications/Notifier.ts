import type { Notice, NotificationChannelKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A notice as a part of the admin hands it over: what it says, when it was raised, and what it tells of.
 *
 * The subjects are names the sender chooses for the things the notice is about, such as one warning or one coming
 * top-up. They let a notice that waits for a channel be dropped once none of them stands, and nothing else reads
 * them.
 */
export interface OutgoingNotice extends Notice {
  /** When what it tells of was found. A notice a channel takes late says so. */
  raisedAt: Date;
  /** One or more. */
  subjects: readonly string[];
}

/** What became of one notice. */
export interface NotifyOutcome {
  /** Whether one channel or more took it. */
  notified: boolean;
  /** The channels that took it. */
  taken: NotificationChannelKind[];
  /** The channels that could not, each with why in a sentence. */
  failed: { kind: NotificationChannelKind; error: string }[];
}

/** What became of the notices that waited. */
export interface RetryOutcome {
  /** Taken by their channel on this try. */
  sent: number;
  /** Dropped: older than `NOTIFICATION_WAIT_SECONDS`, or about nothing that stands. */
  dropped: number;
  /** Still waiting. */
  waiting: number;
}

/**
 * How a part of the admin sends a notice to people (docs/architecture/notifications.md). The channels are the ones
 * saved and switched on on the Notifications page; a caller never names one.
 *
 * - `notify` sends the notice on every channel that is on, side by side, and records on each how it went. When one
 *   or more took it, the notice is kept for each channel that could not, to be tried again. When none took it,
 *   nothing is kept, and the caller sends its notice again on its next run.
 * - `retryWaiting` tries each waiting notice again on its channel. It first drops the ones raised more than
 *   `NOTIFICATION_WAIT_SECONDS` ago and the ones none of whose subjects `stands`. A notice sent this way starts with a
 *   line that says when it was raised.
 *
 * Neither throws for a channel that fails: a failure is an outcome.
 */
export interface Notifier {
  /** Whether one channel or more is on. With none, a caller's views are the only place its notices show. */
  on(): Promise<boolean>;
  notify(notice: OutgoingNotice): Promise<NotifyOutcome>;
  retryWaiting(now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome>;
}
