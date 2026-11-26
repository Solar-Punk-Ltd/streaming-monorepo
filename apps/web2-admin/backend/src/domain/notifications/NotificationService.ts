import {
  type ChannelConfig,
  type ChannelFactory,
  findTelegramChats,
  NotificationSendError,
} from '@streaming-monorepo/notifications';
import {
  channelSecretProblem,
  channelSettingsProblems,
  type Notice,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_CHANNEL_NAMES,
  NOTIFICATION_SECRET_NAMES,
  NOTIFICATION_TEST_EVERY_SECONDS,
  type NotificationChannelKind,
  type NotificationChannelSettingsByKind,
  type NotificationChannelView,
  type NotificationsView,
  type NotificationTestResponse,
  storedChannelSecret,
  storedChannelSettings,
  type TelegramChat,
  type TelegramChatsResponse,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { quoteForLog } from '../../utils/logText.js';
import { describeActor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditLog } from '../AuditLog.js';
import {
  NotificationChannelNotSavedError,
  NotificationsUnavailableError,
  NotificationTestTooSoonError,
  RequestShapeError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import { ChannelSecretError, openChannelSecret, sealChannelSecret } from './channelSecrets.js';
import { channelStatusOf } from './channelStatus.js';
import type { NotificationChannelRow, NotificationChannelSave, NotificationStore } from './NotificationStore.js';

const logger = Logger.getInstance();

export interface NotificationServiceDeps {
  store: NotificationStore;
  /**
   * The key the channels' secrets are sealed under and opened with, `channelSecretKeyFrom(BRAND_WALLET_SECRET)`, or null
   * while the admin has no `BRAND_WALLET_SECRET`: then no channel can be saved or tested.
   */
  secretKey: Buffer | null;
  /** Builds the channel a test notice goes out on, from the channel's saved settings and its secret. */
  channelFrom: ChannelFactory;
  audit: AuditLog;
  now?: () => number;
  /** Find chat id's lookup at Telegram with a bot's token: the package's own unless a test hands in another. */
  findTelegramChats?: (token: string) => Promise<TelegramChat[]>;
}

/** A save as the route hands it over, once the operator's password passed. */
export interface NotificationChannelSaveInput {
  /** What the request's body holds, of any shape: `channelSettingsProblems` says why it cannot be saved. */
  settings: unknown;
  /** The secret as typed. Null, empty or spaces keep the saved one. */
  secret: string | null;
}

/** What a channel's saved secret became in a save, as the audit row says it: never the secret itself. */
type SecretChange = 'set' | 'replaced' | 'kept';

/** What stands in for the channel's secret wherever a sentence about a failed send quoted it. */
const SECRET_CUT = '[secret]';

/** The sentence of a test that met an error of the admin's own, which may quote anything: never shown as it is. */
const OWN_ERROR = 'The test notice could not be sent: the admin met an error of its own. Its log has more.';

/** The sentence of a Find chat id that met an error of the admin's own. */
const CHATS_OWN_ERROR = "The bot's chats could not be read: the admin met an error of its own. Its log has more.";

/** `2026-11-25 14:10 UTC`: a moment as a notice writes it. */
function momentText(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The test notice: who asked for it, and when. */
export function testNotice(actor: OperatorActor, at: Date): Notice {
  return {
    title: 'Test notice from the admin',
    text: `${actor.username} sent this test notice from the Notifications page at ${momentText(at)}. The admin's notices will reach you here.`,
  };
}

/** Why a save with no secret is refused for a channel that has none saved. */
function noSecretProblem(kind: NotificationChannelKind): string {
  return `Enter the ${NOTIFICATION_SECRET_NAMES[kind]}: the ${NOTIFICATION_CHANNEL_NAMES[kind]} channel has none saved yet.`;
}

/** The text with the secret cut out, as it is and URL-encoded, wherever a service or a call quoted it. */
function withoutSecret(text: string, secret: string): string {
  let clean = text;
  for (const form of new Set([secret, encodeURIComponent(secret)])) {
    if (form !== '') clean = clean.split(form).join(SECRET_CUT);
  }
  return clean;
}

/** How long until the channel's next test may go out, in whole seconds from 1 to a minute. */
function secondsUntilNextTest(lastTestAt: Date | null, at: Date): number {
  const elapsedSeconds = lastTestAt === null ? 0 : Math.max(0, (at.getTime() - lastTestAt.getTime()) / 1000);
  return Math.min(
    NOTIFICATION_TEST_EVERY_SECONDS,
    Math.max(1, Math.ceil(NOTIFICATION_TEST_EVERY_SECONDS - elapsedSeconds)),
  );
}

/**
 * A channel as the page shows it: its status as the Auto top-up tab shows it too, then its settings, who saved it and
 * its last test, all null while it was never saved. Never its secret.
 */
function channelViewOf(
  kind: NotificationChannelKind,
  row: NotificationChannelRow | undefined,
  waiting: number,
): NotificationChannelView {
  return {
    ...channelStatusOf(kind, row, waiting),
    settings: row?.settings ?? null,
    savedBy: row?.savedBy ?? null,
    savedAt: row?.savedAt.toISOString() ?? null,
    lastTestAt: row?.lastTestAt?.toISOString() ?? null,
    lastTestError: row?.lastTestError ?? null,
  } as NotificationChannelView;
}

/**
 * The Notifications page (docs/architecture/notifications.md): the view of the channels, and their save, switch,
 * removal and test notice. The notices themselves go out through the `Notifier`, which reads the same store.
 *
 * - A save comes after the operator's password, which the route checks. Its settings and its secret are checked with
 *   the package's rules, the secret is sealed with AES-256-GCM, and the store keeps it. A channel's first save switches
 *   it on and a later one keeps its switch. A save whose secret is empty keeps the saved one.
 * - Switching a channel and removing it take no password. Removing it deletes its secret.
 * - A test notice goes out on a saved channel, on or off, with its saved settings and secret: one a minute at most on
 *   a channel, claimed in the store so two requests at once send one. Its outcome is the channel's `lastTestAt` and
 *   `lastTestError` alone: it counts as no notice, records no send or failure, and leaves the waiting notices be.
 * - Find chat id reads, with the bot's token as typed or the saved one, the chats that wrote to the Telegram bot within
 *   the last day. It changes nothing, so it is neither audited nor limited, and it logs how many chats it found, never
 *   their names.
 *
 * Every write is audited with the operator's name, and logged with the channel and the outcome. No answer, log line or
 * audit row carries a channel's secret: a secret is opened for the one test or lookup that needs it, and a failure's
 * sentence has it cut out.
 */
export class NotificationService {
  private readonly store: NotificationStore;
  private readonly secretKey: Buffer | null;
  private readonly channelFrom: ChannelFactory;
  private readonly audit: AuditLog;
  private readonly now: () => number;
  private readonly findTelegramChats: (token: string) => Promise<TelegramChat[]>;

  constructor(deps: NotificationServiceDeps) {
    this.store = deps.store;
    this.secretKey = deps.secretKey;
    this.channelFrom = deps.channelFrom;
    this.audit = deps.audit;
    this.now = deps.now ?? Date.now;
    this.findTelegramChats = deps.findTelegramChats ?? ((token) => findTelegramChats(token));
  }

  /** `GET /api/notifications`: every channel, saved or not, in the order of `NOTIFICATION_CHANNEL_KINDS`. */
  async view(): Promise<NotificationsView> {
    const [rows, waiting] = await Promise.all([this.store.channels(), this.store.waitingCounts()]);
    return {
      available: this.secretKey !== null,
      channels: NOTIFICATION_CHANNEL_KINDS.map((kind) =>
        channelViewOf(
          kind,
          rows.find((channel) => channel.kind === kind),
          waiting.get(kind) ?? 0,
        ),
      ),
    };
  }

  /**
   * `PUT /api/notifications/channels/:kind`, once the operator's password passed: saves the settings and the secret
   * the package's rules pass, every problem at once in a `RequestShapeError`. Without `BRAND_WALLET_SECRET` nothing is
   * read or saved.
   */
  async save(
    actor: OperatorActor,
    kind: NotificationChannelKind,
    input: NotificationChannelSaveInput,
  ): Promise<NotificationsView> {
    const key = this.requireKey();
    const secret = input.secret === null ? '' : storedChannelSecret(input.secret);
    const keepsSecret = secret === '';
    const known = (await this.store.channels()).some((channel) => channel.kind === kind);

    const problems = channelSettingsProblems(kind, input.settings);
    if (keepsSecret) {
      if (!known) problems.push(noSecretProblem(kind));
    } else {
      const problem = channelSecretProblem(kind, secret);
      if (problem !== null) problems.push(problem);
    }
    if (problems.length > 0) throw new RequestShapeError(problems);

    const settings = storedChannelSettings(kind, input.settings as NotificationChannelSettingsByKind[typeof kind]);
    const sealed = keepsSecret ? null : sealChannelSecret(kind, secret, key);
    const save = { kind, settings, secret: sealed } as NotificationChannelSave;
    // False only when the channel was removed since it was read, and the save keeps a secret it no longer has.
    if (!(await this.store.saveChannel(save, actor.username, new Date(this.now())))) {
      throw new RequestShapeError([noSecretProblem(kind)]);
    }

    const secretChange: SecretChange = keepsSecret ? 'kept' : known ? 'replaced' : 'set';
    logger.info(
      `[Notifications] ${describeActor(actor)} saved the ${NOTIFICATION_CHANNEL_NAMES[kind]} channel${
        known ? '' : ', which starts on'
      }: its secret ${secretChange}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'notification.channel.save',
      details: { kind, settings, secret: secretChange },
    });
    return this.view();
  }

  /**
   * `PUT /api/notifications/channels/:kind/enabled`: switches a saved channel on or off. Off drops the notices that wait
   * for it. A channel never saved is a `NotificationChannelNotSavedError`.
   */
  async setEnabled(actor: OperatorActor, kind: NotificationChannelKind, enabled: boolean): Promise<NotificationsView> {
    if (!(await this.store.setEnabled(kind, enabled))) throw new NotificationChannelNotSavedError(kind);
    logger.info(
      `[Notifications] ${describeActor(actor)} switched the ${NOTIFICATION_CHANNEL_NAMES[kind]} channel ${enabled ? 'on' : 'off'}`,
    );
    await recordAudit(this.audit, { actor, action: 'notification.channel.enabled', details: { kind, enabled } });
    return this.view();
  }

  /**
   * `DELETE /api/notifications/channels/:kind`: removes the channel with its secret and the notices that wait for it.
   * A channel that was not saved stays so, and nothing is audited, since nothing moved.
   */
  async remove(actor: OperatorActor, kind: NotificationChannelKind): Promise<NotificationsView> {
    const known = (await this.store.channels()).some((channel) => channel.kind === kind);
    await this.store.removeChannel(kind);
    if (known) {
      logger.info(
        `[Notifications] ${describeActor(actor)} removed the ${NOTIFICATION_CHANNEL_NAMES[kind]} channel with its secret`,
      );
      await recordAudit(this.audit, { actor, action: 'notification.channel.remove', details: { kind } });
    }
    return this.view();
  }

  /**
   * `POST /api/notifications/channels/:kind/test`: sends the test notice on the saved channel, on or off, with its
   * saved settings and secret, and answers whether the service took it. Refused without `BRAND_WALLET_SECRET`, for a
   * channel not saved, and within a minute of the channel's last test.
   */
  async test(actor: OperatorActor, kind: NotificationChannelKind): Promise<NotificationTestResponse> {
    const key = this.requireKey();
    const at = new Date(this.now());
    const claimed = await this.store.claimTest(kind, at, NOTIFICATION_TEST_EVERY_SECONDS);
    // Read after the claim, so the test goes out with what is saved now.
    const row = (await this.store.channels()).find((channel) => channel.kind === kind);
    if (!row) throw new NotificationChannelNotSavedError(kind);
    if (!claimed) throw new NotificationTestTooSoonError(kind, secondsUntilNextTest(row.lastTestAt, at));

    const error = await this.sendTest(row, testNotice(actor, at), key);
    await this.store.recordTest(kind, error);
    const channelName = NOTIFICATION_CHANNEL_NAMES[kind];
    if (error === null) {
      logger.info(
        `[Notifications] ${describeActor(actor)} sent a test notice on the ${channelName} channel: it went out`,
      );
    } else {
      logger.warn(
        `[Notifications] ${describeActor(actor)} sent a test notice on the ${channelName} channel: it could not be sent: ${quoteForLog(error)}`,
      );
    }
    await recordAudit(this.audit, {
      actor,
      action: 'notification.channel.test',
      details: { kind, sent: error === null, error },
    });
    return { sent: error === null, error, view: await this.view() };
  }

  /**
   * `POST /api/notifications/channels/telegram/chats`: Find chat id. Reads the chats that wrote to the bot within the
   * last day with `typed`, the token as typed on the page, or with the saved channel's when none is typed. A typed
   * token the rules refuse is a `RequestShapeError`. With none typed, it is refused without `BRAND_WALLET_SECRET` and
   * for a channel never saved. Why Telegram could not be asked, or its answer read, is the answer's `error`.
   */
  async telegramChats(actor: OperatorActor, typed: string | null): Promise<TelegramChatsResponse> {
    const typedToken = typed === null ? '' : storedChannelSecret(typed);
    let token: string;
    if (typedToken !== '') {
      const problem = channelSecretProblem('telegram', typedToken);
      if (problem !== null) throw new RequestShapeError([problem]);
      token = typedToken;
    } else {
      const key = this.requireKey();
      const row = (await this.store.channels()).find((channel) => channel.kind === 'telegram');
      if (!row) throw new NotificationChannelNotSavedError('telegram');
      try {
        token = openChannelSecret('telegram', row.secret, key);
      } catch (error) {
        // openChannelSecret's sentences name the channel and the setting, never the secret or the key.
        if (error instanceof ChannelSecretError) return { chats: [], error: error.message };
        logger.error(`[Notifications] the telegram channel's secret could not be opened: ${getErrorMessage(error)}`);
        return { chats: [], error: CHATS_OWN_ERROR };
      }
    }

    const lookup = `${describeActor(actor)} looked up the Telegram bot's chats with ${
      typedToken === '' ? "the saved channel's token" : 'the token typed'
    }`;
    try {
      const chats = await this.findTelegramChats(token);
      logger.info(`[Notifications] ${lookup}: ${chats.length === 1 ? '1 chat' : `${chats.length} chats`} found`);
      return { chats, error: null };
    } catch (error) {
      if (error instanceof NotificationSendError) {
        const sentence = withoutSecret(error.message, token);
        logger.warn(`[Notifications] ${lookup}: ${quoteForLog(sentence)}`);
        return { chats: [], error: sentence };
      }
      logger.error(
        `[Notifications] a lookup of the Telegram bot's chats met an error of the admin's own: ${quoteForLog(
          withoutSecret(getErrorMessage(error), token),
        )}`,
      );
      return { chats: [], error: CHATS_OWN_ERROR };
    }
  }

  /** The key, or a `NotificationsUnavailableError` while the admin has no `BRAND_WALLET_SECRET`. */
  private requireKey(): Buffer {
    if (this.secretKey === null) throw new NotificationsUnavailableError();
    return this.secretKey;
  }

  /** Sends the notice on the saved channel: null once the service took it, or why it could not, without the secret. */
  private async sendTest(row: NotificationChannelRow, notice: Notice, key: Buffer): Promise<string | null> {
    let secret: string;
    try {
      secret = openChannelSecret(row.kind, row.secret, key);
    } catch (error) {
      // openChannelSecret's sentences name the channel and the setting, never the secret or the key.
      if (error instanceof ChannelSecretError) return error.message;
      logger.error(`[Notifications] the ${row.kind} channel's secret could not be opened: ${getErrorMessage(error)}`);
      return OWN_ERROR;
    }
    try {
      const config = { kind: row.kind, settings: row.settings, secret } as ChannelConfig;
      await this.channelFrom(config).send(notice);
      return null;
    } catch (error) {
      if (error instanceof NotificationSendError) return withoutSecret(error.message, secret);
      logger.error(
        `[Notifications] a test notice on the ${row.kind} channel met an error of the admin's own: ${quoteForLog(
          withoutSecret(getErrorMessage(error), secret),
        )}`,
      );
      return OWN_ERROR;
    }
  }
}
