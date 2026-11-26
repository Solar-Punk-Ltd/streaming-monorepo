import { NotificationSendError, type Channel, type ChannelFactory } from '@streaming-monorepo/notifications';
import {
  NOTIFICATION_WAIT_SECONDS,
  type Notice,
  type NoticeTopic,
  type NotificationChannelKind,
} from '@streaming-monorepo/web2-admin-common';

import type { Logger } from '../Logger.js';

import type { NotificationChannelRow, NotificationStore, WaitingDeliveryRow } from './NotificationStore.js';
import type { NotifyOutcome, Notifier, OutgoingNotice, RetryOutcome } from './Notifier.js';
import { ChannelSecretError, openChannelSecret } from './channelSecrets.js';

/**
 * The admin's {@link Notifier} over the channels of migration 035: it sends a notice on every channel that is on,
 * side by side, records on each how it went, and keeps a notice for each channel that could not take it while another
 * did. It decides nothing of what a notice says or when one goes out.
 *
 * It reads the channels where the `Notifier` speaks of people: every channel that is on gets every topic, so a notice
 * goes out whole, written from all its parts, and a channel counts as one person with one destination.
 *
 * A channel is built for each send from its saved row: its secret is opened for that send and handed to the factory,
 * and nothing keeps it. With no key, as when `BRAND_WALLET_SECRET` is unset, a saved channel cannot be opened, and
 * each send on it fails with a sentence that says so.
 *
 * No log line, recorded error or outcome holds a secret: a failure is the sentence of a `NotificationSendError` or a
 * `ChannelSecretError`, which carry none, or a fixed sentence for anything else.
 */
export interface NotificationDispatcherOptions {
  store: NotificationStore;
  /** The key the channels' secrets are sealed under (`channelSecretKeyFrom`), or null when the admin has none. */
  key: Buffer | null;
  /** Builds a channel from its settings and its opened secret: the package's `channelFrom`, or a fake in a test. */
  channelFrom: ChannelFactory;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The clock a send is recorded at. */
  now?: () => Date;
}

/** `2026-11-25 14:10 UTC`. */
function momentText(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The text of a notice a channel takes late: a line that says when it was raised, then the notice's own text. */
export function lateNoticeText(text: string, raisedAt: Date): string {
  return `Raised ${momentText(raisedAt)}. This channel could not take it then.\n\n${text}`;
}

/** Why a send failed, in a sentence that holds no secret. */
function failureSentence(kind: NotificationChannelKind, error: unknown): string {
  if (error instanceof NotificationSendError || error instanceof ChannelSecretError) return error.message;
  return `The ${kind} channel could not send the notice: an unexpected error.`;
}

export class NotificationDispatcher implements Notifier {
  private readonly store: NotificationStore;
  private readonly key: Buffer | null;
  private readonly channelFrom: ChannelFactory;
  private readonly logger: Pick<Logger, 'info' | 'warn'>;
  private readonly now: () => Date;

  constructor(options: NotificationDispatcherOptions) {
    this.store = options.store;
    this.key = options.key;
    this.channelFrom = options.channelFrom;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async on(_topic: NoticeTopic): Promise<boolean> {
    return (await this.store.channels()).some((channel) => channel.enabled);
  }

  async notify<T>(outgoing: OutgoingNotice<T>): Promise<NotifyOutcome> {
    const channels = (await this.store.channels()).filter((channel) => channel.enabled);
    const outcomeOf = (sent: number, failed: number): NotifyOutcome => ({
      parts: outgoing.parts.map((part) => ({ subject: part.subject, people: channels.length, taken: sent > 0 })),
      sent,
      failed,
    });
    if (channels.length === 0) return outcomeOf(0, 0);
    const notice = {
      ...outgoing.compose(outgoing.parts),
      raisedAt: outgoing.raisedAt,
      subjects: outgoing.parts.map((part) => part.subject),
    };
    const results = await Promise.all(
      channels.map(async (row) => ({
        kind: row.kind,
        error: await this.sendOn(row, { title: notice.title, text: notice.text }),
      })),
    );
    const at = this.now();
    const taken: NotificationChannelKind[] = [];
    const failed: { kind: NotificationChannelKind; error: string }[] = [];
    for (const { kind, error } of results) {
      if (error === null) {
        taken.push(kind);
        await this.store.recordSent(kind, at);
      } else {
        failed.push({ kind, error });
        await this.store.recordFailed(kind, at, error);
        this.logger.warn(`[Notifications] the ${kind} channel could not take "${notice.title}": ${error}`);
      }
    }
    if (taken.length > 0) {
      this.logger.info(`[Notifications] "${notice.title}" went out on ${taken.join(', ')}`);
      if (failed.length > 0) {
        await this.store.addWaiting(
          failed.map(({ kind, error }) => ({
            channel: kind,
            title: notice.title,
            text: notice.text,
            subjects: notice.subjects,
            raisedAt: notice.raisedAt,
            error,
          })),
        );
      }
    }
    return outcomeOf(taken.length, failed.length);
  }

  /**
   * Drops the waiting notices raised `NOTIFICATION_WAIT_SECONDS` ago or more, the ones none of whose subjects stands,
   * and any whose channel is off, then tries the rest, the earliest raised first, each channel side by side. A channel
   * that fails a notice is tried no more in this run: its other notices wait for the next.
   */
  async retryWaiting(now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome> {
    const rows = await this.store.waiting();
    if (rows.length === 0) return { sent: 0, dropped: 0, waiting: 0 };
    const channels = new Map((await this.store.channels()).map((channel) => [channel.kind, channel]));
    const oldest = now.getTime() - NOTIFICATION_WAIT_SECONDS * 1000;

    const drop: string[] = [];
    const byChannel = new Map<NotificationChannelKind, WaitingDeliveryRow[]>();
    for (const row of rows) {
      const channel = channels.get(row.channel);
      if (
        row.raisedAt.getTime() <= oldest ||
        !row.subjects.some((subject) => stands(subject)) ||
        channel === undefined ||
        !channel.enabled
      ) {
        drop.push(row.id);
        continue;
      }
      byChannel.set(row.channel, [...(byChannel.get(row.channel) ?? []), row]);
    }
    if (drop.length > 0) await this.store.removeWaiting(drop);

    const tries = await Promise.all(
      [...byChannel].map(([kind, waiting]) => this.retryOn(channels.get(kind)!, waiting, now)),
    );
    const sent = tries.reduce((sum, count) => sum + count, 0);
    return { sent, dropped: drop.length, waiting: rows.length - drop.length - sent };
  }

  /** Tries one channel's waiting notices in order until one fails. Answers how many it took. */
  private async retryOn(
    row: NotificationChannelRow,
    waiting: readonly WaitingDeliveryRow[],
    now: Date,
  ): Promise<number> {
    const opened = this.channelOf(row);
    if ('error' in opened) {
      await this.store.recordAttempt(waiting[0]!.id, opened.error);
      await this.store.recordFailed(row.kind, now, opened.error);
      return 0;
    }
    let sent = 0;
    for (const delivery of waiting) {
      const error = await this.sendWith(opened.channel, row.kind, {
        title: delivery.title,
        text: lateNoticeText(delivery.text, delivery.raisedAt),
      });
      if (error !== null) {
        await this.store.recordAttempt(delivery.id, error);
        await this.store.recordFailed(row.kind, now, error);
        this.logger.warn(`[Notifications] the ${row.kind} channel could not take "${delivery.title}" again: ${error}`);
        break;
      }
      await this.store.removeWaiting([delivery.id]);
      await this.store.recordSent(row.kind, now);
      sent += 1;
    }
    if (sent > 0) this.logger.info(`[Notifications] ${sent} waiting notice(s) went out on ${row.kind}`);
    return sent;
  }

  /** Sends one notice on a saved channel. Answers null once it took it, or why it could not. */
  private async sendOn(row: NotificationChannelRow, notice: Notice): Promise<string | null> {
    const opened = this.channelOf(row);
    if ('error' in opened) return opened.error;
    return this.sendWith(opened.channel, row.kind, notice);
  }

  private async sendWith(channel: Channel, kind: NotificationChannelKind, notice: Notice): Promise<string | null> {
    try {
      await channel.send(notice);
      return null;
    } catch (error) {
      return failureSentence(kind, error);
    }
  }

  /** The channel built from its row, its secret opened for it, or why it could not be. */
  private channelOf(row: NotificationChannelRow): { channel: Channel } | { error: string } {
    if (this.key === null) {
      return { error: `The ${row.kind} channel's secret cannot be opened: the admin has no BRAND_WALLET_SECRET.` };
    }
    try {
      const secret = openChannelSecret(row.kind, row.secret, this.key);
      const channel =
        row.kind === 'email'
          ? this.channelFrom({ kind: 'email', settings: row.settings, secret })
          : row.kind === 'slack'
            ? this.channelFrom({ kind: 'slack', settings: row.settings, secret })
            : this.channelFrom({ kind: 'telegram', settings: row.settings, secret });
      return { channel };
    } catch (error) {
      return { error: failureSentence(row.kind, error) };
    }
  }
}
