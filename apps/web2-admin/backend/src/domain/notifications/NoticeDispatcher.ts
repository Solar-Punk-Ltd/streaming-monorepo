import {
  type DestinationChannelConfig,
  type DestinationChannelFactory,
  NotificationSendError,
} from '@streaming-monorepo/notifications';
import {
  type Notice,
  NOTICE_SERVICE_NAMES,
  type NoticeServiceKind,
  type NoticeTopic,
  NOTIFICATION_WAIT_SECONDS,
} from '@streaming-monorepo/web2-admin-common';

import type { Logger } from '../Logger.js';

import type {
  NewWaitingNotice,
  NoticeDestinationKey,
  NoticeDestinationRow,
  NoticeRecipient,
  NoticeServiceRow,
  NoticeStore,
  WaitingNoticeRow,
} from './NoticeStore.js';
import type { NotifyOutcome, Notifier, OutgoingNotice, RetryOutcome } from './Notifier.js';
import { ChannelSecretError, openChannelSecret } from './channelSecrets.js';

export interface NoticeDispatcherOptions {
  store: NoticeStore;
  /** The key the services' secrets are sealed under (`channelSecretKeyFrom`), or null when the admin has none. */
  key: Buffer | null;
  /** Builds the channel to one destination: the package's `destinationChannelFrom`, or a fake in a test. */
  channelFrom: DestinationChannelFactory;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The clock a send is recorded at. */
  now?: () => Date;
}

/**
 * Why one send failed, twice over: `error` is kept with the destination, for its user alone to read, and may hold the
 * service's own words; `failure` is what every user reads of the service, and what a log line says, and holds none:
 * the service's status, or that no answer came. Neither holds a secret.
 */
interface SendFailure {
  error: string;
  failure: string;
}

/** A service's secret, opened once for the sends of one run, or why it could not be. */
type OpenedService = { row: NoticeServiceRow; secret: string } | { failure: SendFailure };

/** What became of one send, as a service's record reads it. */
interface SendOutcome {
  kind: NoticeServiceKind;
  failure: SendFailure | null;
}

/** `2026-11-25 14:10 UTC`. */
function momentText(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The text of a notice a destination takes late: a line that says when it was raised, then the notice's own text. */
export function lateNoticeText(text: string, raisedAt: Date): string {
  return `Raised ${momentText(raisedAt)}. It could not reach you here then.\n\n${text}`;
}

/** Why a send through the service failed, in words every user may read: no address and none of the service's words. */
export function serviceFailureSentence(kind: NoticeServiceKind, error: unknown): string {
  const name = NOTICE_SERVICE_NAMES[kind];
  if (error instanceof NotificationSendError) {
    return error.status === null
      ? `The ${name} service gave no answer.`
      : `The ${name} service answered ${error.status}.`;
  }
  // Its sentences name the service and the setting, never a secret, a key or an address.
  if (error instanceof ChannelSecretError) return error.message;
  return `The ${name} service could not be used: the admin met an error of its own.`;
}

/** Why a send failed, as its user reads it: the package's sentence, which holds no secret, or a fixed one. */
function destinationErrorSentence(kind: NoticeServiceKind, error: unknown): string {
  if (error instanceof NotificationSendError || error instanceof ChannelSecretError) return error.message;
  return `The ${NOTICE_SERVICE_NAMES[kind]} service could not send the notice: the admin met an error of its own.`;
}

function failureOf(kind: NoticeServiceKind, error: unknown): SendFailure {
  return { error: destinationErrorSentence(kind, error), failure: serviceFailureSentence(kind, error) };
}

/** The same sentence for its user and for every user: one that holds no address and no service's words. */
function plainFailure(sentence: string): SendFailure {
  return { error: sentence, failure: sentence };
}

function keyText(key: NoticeDestinationKey): string {
  return `${key.userId}:${key.kind}`;
}

/** One person's notice: the places in the notice of the parts whose topics they get, and the notice written of them. */
interface PersonalNotice {
  recipient: NoticeRecipient;
  places: number[];
  notice: Notice;
}

/**
 * The admin's {@link Notifier} over the services and each user's destinations of migration 037
 * (docs/architecture/notifications.md). It writes each person the notice of the parts whose topics they get, sends
 * it to each of their destinations that is on, every destination side by side, records on each destination and on its
 * service how the send went, and keeps a notice for a destination that could not take its own while another took
 * what it tells of. It decides nothing of what a notice says or when one goes out.
 *
 * A service's secret is opened once for a run's sends and handed to the factory with each destination; nothing keeps
 * it. With no key, as when `BRAND_WALLET_SECRET` is unset, no secret opens, and every send fails with a sentence that
 * says so.
 *
 * No log line holds a secret, an address or a service's own words: a log line names the service, counts, and the
 * service's status.
 */
export class NoticeDispatcher implements Notifier {
  private readonly store: NoticeStore;
  private readonly key: Buffer | null;
  private readonly channelFrom: DestinationChannelFactory;
  private readonly logger: Pick<Logger, 'info' | 'warn'>;
  private readonly now: () => Date;

  constructor(options: NoticeDispatcherOptions) {
    this.store = options.store;
    this.key = options.key;
    this.channelFrom = options.channelFrom;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async on(topic: NoticeTopic): Promise<boolean> {
    return (await this.store.recipients()).some((recipient) => recipient.topics.includes(topic));
  }

  async notify<T>(outgoing: OutgoingNotice<T>): Promise<NotifyOutcome> {
    const recipients = await this.store.recipients();
    const people = outgoing.parts.map(
      (part) => recipients.filter((recipient) => recipient.topics.includes(part.topic)).length,
    );
    const partsAt = (places: readonly number[]) => places.map((place) => outgoing.parts[place]!);

    // One notice for each person, written once, from the parts whose topics they get.
    const personal: PersonalNotice[] = [];
    for (const recipient of recipients) {
      const places = outgoing.parts.flatMap((part, place) => (recipient.topics.includes(part.topic) ? [place] : []));
      if (places.length > 0) personal.push({ recipient, places, notice: outgoing.compose(partsAt(places)) });
    }

    const sends = personal.flatMap((notice) =>
      notice.recipient.destinations.map((destination) => ({ personal: notice, destination })),
    );
    const outcomeOf = (taken: ReadonlySet<number>, sent: number, failed: number): NotifyOutcome => ({
      parts: outgoing.parts.map((part, place) => ({
        subject: part.subject,
        people: people[place]!,
        taken: taken.has(place),
      })),
      sent,
      failed,
    });
    if (sends.length === 0) return outcomeOf(new Set(), 0, 0);

    const services = await this.openServices(new Set(sends.map((send) => send.destination.kind)));
    const results = await Promise.all(
      sends.map(async (send) => ({
        ...send,
        failure: await this.send(services.get(send.destination.kind), send.destination, send.personal.notice),
      })),
    );

    const at = this.now();
    const taken = new Set<number>();
    for (const result of results) {
      if (result.failure === null) for (const place of result.personal.places) taken.add(place);
    }
    const waiting: NewWaitingNotice[] = [];
    let sent = 0;
    for (const result of results) {
      const key = { userId: result.destination.userId, kind: result.destination.kind };
      if (result.failure === null) {
        sent += 1;
        await this.store.recordSent(key, at);
        continue;
      }
      await this.store.recordFailed(key, at, result.failure.error);
      // What another destination took is kept for this one, as one notice of those parts alone.
      const kept = result.personal.places.filter((place) => taken.has(place));
      if (kept.length === 0) continue;
      const notice =
        kept.length === result.personal.places.length ? result.personal.notice : outgoing.compose(partsAt(kept));
      waiting.push({
        ...key,
        title: notice.title,
        text: notice.text,
        subjects: partsAt(kept).map((part) => part.subject),
        raisedAt: outgoing.raisedAt,
        error: result.failure.error,
      });
    }
    await this.recordServices(
      results.map((result) => ({ kind: result.destination.kind, failure: result.failure })),
      at,
    );
    await this.store.addWaiting(waiting);

    const failed = results.length - sent;
    this.logger.info(
      `[Notifications] a notice of ${outgoing.parts.length} part(s) for ${personal.length} person(s) went to ${sent} destination(s)${
        failed === 0 ? '' : `, failed on ${failed}, and waits for ${waiting.length}`
      }`,
    );
    return outcomeOf(taken, sent, failed);
  }

  /**
   * Drops the waiting notices raised `NOTIFICATION_WAIT_SECONDS` ago or more, the ones none of whose subjects stands,
   * and any whose destination or service is off or gone, then tries the rest, the earliest raised first, each
   * destination side by side. A destination that fails a notice is tried no more in this run: its other notices wait
   * for the next.
   */
  async retryWaiting(now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome> {
    const rows = await this.store.waiting();
    if (rows.length === 0) return { sent: 0, dropped: 0, waiting: 0 };
    const serviceRows = new Map((await this.store.services()).map((row) => [row.kind, row]));
    const destinations = new Map<string, NoticeDestinationRow>();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      for (const destination of await this.store.destinations(userId)) {
        destinations.set(keyText(destination), destination);
      }
    }
    const oldest = now.getTime() - NOTIFICATION_WAIT_SECONDS * 1000;

    const drop: string[] = [];
    const byDestination = new Map<string, WaitingNoticeRow[]>();
    for (const row of rows) {
      const destination = destinations.get(keyText(row));
      if (
        row.raisedAt.getTime() <= oldest ||
        !row.subjects.some((subject) => stands(subject)) ||
        destination === undefined ||
        !destination.enabled ||
        !serviceRows.get(row.kind)?.enabled
      ) {
        drop.push(row.id);
        continue;
      }
      byDestination.set(keyText(row), [...(byDestination.get(keyText(row)) ?? []), row]);
    }
    if (drop.length > 0) await this.store.removeWaiting(drop);
    if (byDestination.size === 0) return { sent: 0, dropped: drop.length, waiting: 0 };

    const services = await this.openServices(new Set([...byDestination.values()].map((waiting) => waiting[0]!.kind)));
    const tries = await Promise.all(
      [...byDestination].map(([key, waiting]) =>
        this.retryOn(services.get(waiting[0]!.kind), destinations.get(key)!, waiting, now),
      ),
    );
    await this.recordServices(
      tries.flatMap((attempt) => attempt.outcomes),
      now,
    );
    const sent = tries.reduce((sum, attempt) => sum + attempt.sent, 0);
    if (sent > 0) this.logger.info(`[Notifications] ${sent} waiting notice(s) reached their destination`);
    return { sent, dropped: drop.length, waiting: rows.length - drop.length - sent };
  }

  /** Tries one destination's waiting notices in order until one fails. Answers how many it took, and each try. */
  private async retryOn(
    service: OpenedService | undefined,
    destination: NoticeDestinationRow,
    waiting: readonly WaitingNoticeRow[],
    now: Date,
  ): Promise<{ sent: number; outcomes: SendOutcome[] }> {
    const key = { userId: destination.userId, kind: destination.kind };
    const outcomes: SendOutcome[] = [];
    let sent = 0;
    for (const notice of waiting) {
      const failure = await this.send(service, destination, {
        title: notice.title,
        text: lateNoticeText(notice.text, notice.raisedAt),
      });
      outcomes.push({ kind: destination.kind, failure });
      if (failure !== null) {
        await this.store.recordAttempt(notice.id, failure.error);
        await this.store.recordFailed(key, now, failure.error);
        break;
      }
      await this.store.removeWaiting([notice.id]);
      await this.store.recordSent(key, now);
      sent += 1;
    }
    return { sent, outcomes };
  }

  /** On each service, whether a send went out, and the latest failure with its sentence for every user. */
  private async recordServices(outcomes: readonly SendOutcome[], at: Date): Promise<void> {
    for (const kind of new Set(outcomes.map((outcome) => outcome.kind))) {
      const mine = outcomes.filter((outcome) => outcome.kind === kind);
      if (mine.some((outcome) => outcome.failure === null)) await this.store.recordServiceSent(kind, at);
      const failures = mine.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
      const last = failures.at(-1);
      if (last) {
        await this.store.recordServiceFailure(kind, at, last.failure);
        this.logger.warn(
          `[Notifications] ${failures.length} send(s) through ${NOTICE_SERVICE_NAMES[kind]} failed: ${last.failure}`,
        );
      }
    }
  }

  /** Each saved service of these kinds with its secret opened, or why it could not be. */
  private async openServices(kinds: ReadonlySet<NoticeServiceKind>): Promise<Map<NoticeServiceKind, OpenedService>> {
    const rows = await this.store.services();
    const opened = new Map<NoticeServiceKind, OpenedService>();
    for (const kind of kinds) {
      const row = rows.find((service) => service.kind === kind);
      if (!row) {
        opened.set(kind, { failure: plainFailure(`The ${NOTICE_SERVICE_NAMES[kind]} service is not saved.`) });
      } else if (this.key === null) {
        opened.set(kind, {
          failure: plainFailure(
            `The ${NOTICE_SERVICE_NAMES[kind]} service's secret cannot be opened: the admin has no BRAND_WALLET_SECRET.`,
          ),
        });
      } else {
        try {
          opened.set(kind, { row, secret: openChannelSecret(kind, row.secret, this.key) });
        } catch (error) {
          opened.set(kind, { failure: failureOf(kind, error) });
        }
      }
    }
    return opened;
  }

  /** Sends one notice to one destination. Answers null once it took it, or why it could not. */
  private async send(
    service: OpenedService | undefined,
    destination: NoticeDestinationRow,
    notice: Notice,
  ): Promise<SendFailure | null> {
    if (service === undefined) {
      return plainFailure(`The ${NOTICE_SERVICE_NAMES[destination.kind]} service is not saved.`);
    }
    if ('failure' in service) return service.failure;
    try {
      const config = {
        kind: service.row.kind,
        settings: service.row.settings,
        secret: service.secret,
        address: destination.address,
      } as DestinationChannelConfig;
      await this.channelFrom(config).send(notice);
      return null;
    } catch (error) {
      return failureOf(destination.kind, error);
    }
  }
}
