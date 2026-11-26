import type { Notice, NoticeTopic } from '@streaming-monorepo/web2-admin-common';

/**
 * One part of a notice: one thing it tells of, under the topic a person picks it by.
 *
 * The subject is a name the sender chooses for that thing, such as one warning or one coming top-up. It stands while
 * the thing does, which lets a notice that waits for a destination be dropped once none of its subjects stands, and
 * it names the part in the outcome. Nothing else reads it.
 */
export interface NoticePart<T = unknown> {
  topic: NoticeTopic;
  subject: string;
  /** What the sender's `compose` writes the part from. */
  item: T;
}

/**
 * A notice as a part of the admin hands it over: its parts, when it was raised, and how it reads for any choice of
 * its parts. A person gets one notice, written from the parts whose topics they ticked.
 */
export interface OutgoingNotice<T = unknown> {
  /** When what it tells of was found. A notice a destination takes late says so. */
  raisedAt: Date;
  /** One or more, in the order the notice lists them. */
  parts: readonly NoticePart<T>[];
  /**
   * Writes the notice of some or all of `parts`, one or more, in their order: its title and its text. It is called
   * once for each choice of parts that someone gets, and it reads nothing but what it is handed.
   */
  compose(parts: readonly NoticePart<T>[]): Notice;
}

/** What became of one part of a notice. */
export interface NoticePartOutcome {
  subject: string;
  /** How many people get its topic. With 0 it went to nobody, and the sender's own view is where it shows. */
  people: number;
  /** Whether one destination or more took a notice that held it. */
  taken: boolean;
}

/**
 * What became of one notice. It holds numbers alone: why a destination failed is kept with that destination, for its
 * user to read.
 */
export interface NotifyOutcome {
  /** One for each part, in the notice's order. */
  parts: NoticePartOutcome[];
  /** How many destinations took their notice. */
  sent: number;
  /** How many could not. */
  failed: number;
}

/** What became of the notices that waited. */
export interface RetryOutcome {
  /** Taken by their destination on this try. */
  sent: number;
  /** Dropped: older than `NOTIFICATION_WAIT_SECONDS`, or about nothing that stands. */
  dropped: number;
  /** Still waiting. */
  waiting: number;
}

/**
 * How a part of the admin sends a notice to people (docs/architecture/notifications.md). A caller names topics and
 * never a person or a destination: who gets what is each user's own choice on the Notifications page.
 *
 * - `on` says whether anyone gets a topic: a user who ticked it has a destination that is on, on a service that is
 *   saved and on.
 * - `notify` writes each person the notice of the parts whose topics they ticked, with the notice's `compose`, and
 *   sends it to each of that person's destinations that is on, every destination side by side. It records on each
 *   destination, and on its service, how the send went. A part is taken once one destination took a notice that held
 *   it. A destination that could not take its notice has the parts of it that another destination took kept for it,
 *   written as one notice, to be tried again. A part that no destination took is kept for nobody, and the caller
 *   sends it again on its next run.
 * - `retryWaiting` tries each waiting notice again on its destination. It first drops the ones raised more than
 *   `NOTIFICATION_WAIT_SECONDS` ago, the ones none of whose subjects `stands`, and the ones whose destination or
 *   service is off. A notice sent this way starts with a line that says when it was raised.
 *
 * None throws for a destination that fails: a failure is an outcome.
 */
export interface Notifier {
  on(topic: NoticeTopic): Promise<boolean>;
  notify<T>(notice: OutgoingNotice<T>): Promise<NotifyOutcome>;
  retryWaiting(now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome>;
}
