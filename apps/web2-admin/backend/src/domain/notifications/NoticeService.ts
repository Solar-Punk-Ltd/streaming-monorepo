import { randomInt } from 'node:crypto';

import {
  type DestinationChannelConfig,
  type DestinationChannelFactory,
  NotificationSendError,
  type TelegramBotLookup,
  type TelegramChatLookup,
} from '@streaming-monorepo/notifications';
import {
  destinationAddressProblem,
  type MyDestination,
  type MyNoticeTestResponse,
  type Notice,
  NOTICE_DESTINATION_NAMES,
  NOTICE_SERVICE_KINDS,
  NOTICE_SERVICE_NAMES,
  NOTICE_SERVICE_SECRET_NAMES,
  NOTICE_TOPICS,
  type NoticeServiceKind,
  type NoticeServiceSettingsByKind,
  type NoticeServiceView,
  type NoticesView,
  noticeTopicsProblem,
  NOTIFICATION_TEST_EVERY_SECONDS,
  serviceSecretProblem,
  serviceSettingsProblems,
  STARTING_NOTICE_TOPICS,
  storedChannelSecret,
  storedDestinationAddress,
  storedNoticeTopics,
  storedServiceSettings,
  TELEGRAM_CHAT_CODE_ALPHABET,
  TELEGRAM_CHAT_CODE_LENGTH,
  TELEGRAM_CHAT_CODE_SECONDS,
  type TelegramChatResponse,
  type TelegramCodeResponse,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { quoteForLog } from '../../utils/logText.js';
import { describeActor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditLog } from '../AuditLog.js';
import {
  AdminRequiredError,
  NoticeDestinationNotSavedError,
  NoticeServiceNotSavedError,
  NoticeTestTooSoonError,
  NotificationsUnavailableError,
  RequestShapeError,
  TelegramCodeNotStartedError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import { serviceFailureSentence } from './NoticeDispatcher.js';
import type { NoticeDestinationRow, NoticeServiceRow, NoticeServiceSave, NoticeStore } from './NoticeStore.js';
import { ChannelSecretError, openChannelSecret, sealChannelSecret } from './channelSecrets.js';

const logger = Logger.getInstance();

/** The signed-in user a call of the page is made by: the session's own, and whether they have the admin role. */
export type NoticeUser = OperatorActor & { isAdmin: boolean };

export interface NoticeServiceDeps {
  store: NoticeStore;
  /**
   * The key the services' secrets are sealed under and opened with, `channelSecretKeyFrom(BRAND_WALLET_SECRET)`, or
   * null while the admin has no `BRAND_WALLET_SECRET`: then no service can be saved, and no test or code goes out.
   */
  secretKey: Buffer | null;
  /** Builds the channel a test notice goes to one destination on: the package's `destinationChannelFrom`. */
  channelFrom: DestinationChannelFactory;
  /** Reads the bot a token is of: the package's `lookUpTelegramBot`. */
  lookUpTelegramBot: TelegramBotLookup;
  /** Finds the chat that sent a code to the bot: the package's `findTelegramChatByCode`. */
  findTelegramChat: TelegramChatLookup;
  audit: AuditLog;
  now?: () => number;
  /** Draws a code to find a Telegram chat. A test hands in its own. */
  drawCode?: () => string;
}

/** A service's save as the route hands it over, once the password passed. */
export interface NoticeServiceSaveInput {
  /** What the request's body holds, of any shape: `serviceSettingsProblems` says why it cannot be saved. */
  settings: unknown;
  /** The secret as typed. Null, empty or spaces keep the saved one. */
  secret: string | null;
}

/** What a service's saved secret became in a save, as the audit row says it: never the secret itself. */
type SecretChange = 'set' | 'replaced' | 'kept';

/** What stands in for a secret wherever a sentence about a failed call quoted it. */
const SECRET_CUT = '[secret]';

/** The sentence of a test that met an error of the admin's own, which may quote anything: never shown as it is. */
const OWN_ERROR = 'The test notice could not be sent: the admin met an error of its own. Its log has more.';

/** The sentence of a Telegram lookup that met an error of the admin's own. */
const TELEGRAM_OWN_ERROR = 'The Telegram bot could not be asked: the admin met an error of its own. Its log has more.';

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

/** A code to find a Telegram chat: drawn at random, each character alike, from `TELEGRAM_CHAT_CODE_ALPHABET`. */
export function drawTelegramChatCode(): string {
  let code = '';
  for (let at = 0; at < TELEGRAM_CHAT_CODE_LENGTH; at += 1) {
    code += TELEGRAM_CHAT_CODE_ALPHABET[randomInt(TELEGRAM_CHAT_CODE_ALPHABET.length)];
  }
  return code;
}

/** Why a save with no secret is refused for a service that has none saved. */
function noSecretProblem(kind: NoticeServiceKind): string {
  return `Enter the ${NOTICE_SERVICE_SECRET_NAMES[kind]}: the ${NOTICE_SERVICE_NAMES[kind]} service has none saved yet.`;
}

/** The text with the secret cut out, as it is and URL-encoded, wherever a service or a call quoted it. */
function withoutSecret(text: string, secret: string): string {
  let clean = text;
  for (const form of new Set([secret, encodeURIComponent(secret)])) {
    if (form !== '') clean = clean.split(form).join(SECRET_CUT);
  }
  return clean;
}

/** How long until the destination's next test may go out, in whole seconds from 1 to a minute. */
function secondsUntilNextTest(lastTestAt: Date | null, at: Date): number {
  const elapsedSeconds = lastTestAt === null ? 0 : Math.max(0, (at.getTime() - lastTestAt.getTime()) / 1000);
  return Math.min(
    NOTIFICATION_TEST_EVERY_SECONDS,
    Math.max(1, Math.ceil(NOTIFICATION_TEST_EVERY_SECONDS - elapsedSeconds)),
  );
}

/** My destination on a service as the page shows it, or as never saved and off without one. */
function myDestinationOf(
  kind: NoticeServiceKind,
  row: NoticeDestinationRow | undefined,
  waiting: number,
): MyDestination {
  return {
    kind,
    address: row?.address ?? null,
    enabled: row?.enabled ?? false,
    savedAt: row?.savedAt.toISOString() ?? null,
    lastSentAt: row?.lastSentAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
    waiting: row ? waiting : 0,
    lastTestAt: row?.lastTestAt?.toISOString() ?? null,
    lastTestError: row?.lastTestError ?? null,
  };
}

/**
 * The Notifications page (docs/architecture/notifications.md): the services the brand shares, and each signed-in
 * user's own destinations and topics. The notices themselves go out through the `NoticeDispatcher`, which reads the
 * same store.
 *
 * - The services are saved, switched and removed by a user with the admin role, which the routes check and this
 *   checks again. A save comes after the password, which the route checks. Its settings and its secret are checked
 *   with the package's rules, the secret is sealed with AES-256-GCM, and the store keeps it.
 * - A user's own destinations and topics are read and written by the session's user alone. A destination's save comes
 *   after the password; its switch, its removal and the topics take none. The first destination ticks the starting
 *   topics, unless the user saved topics before.
 * - A test notice goes to the user's saved destination, on or off, through the saved service, on or off: one a minute
 *   at most on a destination, claimed in the store so two requests at once send one. Its outcome is the destination's
 *   `lastTestAt` and `lastTestError` alone.
 * - Find my chat: a code the user sends to the bot, then a read of the bot's latest messages for the chat that sent it.
 *   Neither changes anything at Telegram or any destination, so neither is audited.
 *
 * Every write is audited with the user's name and logged with the service. No answer, log line or audit row carries a
 * service's secret, and no log line or audit row carries a user's address or chat: a secret is opened for the one test
 * or lookup that needs it, and a failure's sentence has it cut out.
 */
export class NoticeService {
  private readonly store: NoticeStore;
  private readonly secretKey: Buffer | null;
  private readonly channelFrom: DestinationChannelFactory;
  private readonly lookUpTelegramBot: TelegramBotLookup;
  private readonly findTelegramChat: TelegramChatLookup;
  private readonly audit: AuditLog;
  private readonly now: () => number;
  private readonly drawCode: () => string;

  constructor(deps: NoticeServiceDeps) {
    this.store = deps.store;
    this.secretKey = deps.secretKey;
    this.channelFrom = deps.channelFrom;
    this.lookUpTelegramBot = deps.lookUpTelegramBot;
    this.findTelegramChat = deps.findTelegramChat;
    this.audit = deps.audit;
    this.now = deps.now ?? Date.now;
    this.drawCode = deps.drawCode ?? drawTelegramChatCode;
  }

  /**
   * `GET /api/notifications`: every service, saved or not, its settings and who saved it for a user with the admin
   * role alone; the user's own destinations and topics; and how many people get each topic. Of the other users it
   * holds numbers alone.
   */
  async view(user: NoticeUser): Promise<NoticesView> {
    const [services, counts, destinations, topics, waiting, recipients] = await Promise.all([
      this.store.services(),
      this.store.serviceCounts(),
      this.store.destinations(user.userId),
      this.store.topics(user.userId),
      this.store.waitingCounts(user.userId),
      this.store.recipients(),
    ]);
    return {
      available: this.secretKey !== null,
      managesServices: user.isAdmin,
      services: NOTICE_SERVICE_KINDS.map((kind) => {
        const row = services.find((service) => service.kind === kind);
        const count = counts.find((one) => one.kind === kind);
        return {
          kind,
          saved: row !== undefined,
          enabled: row?.enabled ?? false,
          lastSentAt: row?.lastSentAt?.toISOString() ?? null,
          lastFailure: row?.lastFailure ?? null,
          lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
          people: count?.people ?? 0,
          failing: count?.failing ?? 0,
          waiting: count?.waiting ?? 0,
          settings: user.isAdmin ? (row?.settings ?? null) : null,
          savedBy: user.isAdmin ? (row?.savedBy ?? null) : null,
          savedAt: user.isAdmin ? (row?.savedAt.toISOString() ?? null) : null,
        } as NoticeServiceView;
      }),
      destinations: NOTICE_SERVICE_KINDS.map((kind) =>
        myDestinationOf(
          kind,
          destinations.find((destination) => destination.kind === kind),
          waiting.get(kind) ?? 0,
        ),
      ),
      topics: topics ?? [],
      reach: NOTICE_TOPICS.map((topic) => ({
        topic,
        people: recipients.filter((recipient) => recipient.topics.includes(topic)).length,
      })),
    };
  }

  // ------------------------------------------------------------------ the services

  /**
   * `PUT /api/notifications/services/:kind`, once the password passed: saves the settings and the secret the package's
   * rules pass, every problem at once in a `RequestShapeError`. Without `BRAND_WALLET_SECRET` nothing is read or saved.
   */
  async saveService(user: NoticeUser, kind: NoticeServiceKind, input: NoticeServiceSaveInput): Promise<NoticesView> {
    this.requireAdmin(user);
    const key = this.requireKey();
    const secret = input.secret === null ? '' : storedChannelSecret(input.secret);
    const keepsSecret = secret === '';
    const known = (await this.store.services()).some((service) => service.kind === kind);

    const problems = serviceSettingsProblems(kind, input.settings);
    if (keepsSecret) {
      if (!known) problems.push(noSecretProblem(kind));
    } else {
      const problem = serviceSecretProblem(kind, secret);
      if (problem !== null) problems.push(problem);
    }
    if (problems.length > 0) throw new RequestShapeError(problems);

    const settings = storedServiceSettings(kind, input.settings as NoticeServiceSettingsByKind[typeof kind]);
    const sealed = keepsSecret ? null : sealChannelSecret(kind, secret, key);
    const save = { kind, settings, secret: sealed } as NoticeServiceSave;
    // False only when the service was removed since it was read, and the save keeps a secret it no longer has.
    if (!(await this.store.saveService(save, user.username, new Date(this.now())))) {
      throw new RequestShapeError([noSecretProblem(kind)]);
    }

    const secretChange: SecretChange = keepsSecret ? 'kept' : known ? 'replaced' : 'set';
    logger.info(
      `[Notifications] ${describeActor(user)} saved the ${NOTICE_SERVICE_NAMES[kind]} service${
        known ? '' : ', which starts on'
      }: its secret ${secretChange}`,
    );
    await recordAudit(this.audit, {
      actor: user,
      action: 'notification.service.save',
      details: { kind, settings, secret: secretChange },
    });
    return this.view(user);
  }

  /**
   * `PUT /api/notifications/services/:kind/enabled`: switches a saved service on or off. Off drops the notices that
   * wait for its destinations. A service never saved is a `NoticeServiceNotSavedError`.
   */
  async setServiceEnabled(user: NoticeUser, kind: NoticeServiceKind, enabled: boolean): Promise<NoticesView> {
    this.requireAdmin(user);
    if (!(await this.store.setServiceEnabled(kind, enabled))) throw new NoticeServiceNotSavedError(kind);
    logger.info(
      `[Notifications] ${describeActor(user)} switched the ${NOTICE_SERVICE_NAMES[kind]} service ${enabled ? 'on' : 'off'}`,
    );
    await recordAudit(this.audit, { actor: user, action: 'notification.service.enabled', details: { kind, enabled } });
    return this.view(user);
  }

  /**
   * `DELETE /api/notifications/services/:kind`: removes the service with its secret and the notices that wait for its
   * destinations. Each user's destination on it stays. A service that was not saved stays so, and nothing is audited.
   */
  async removeService(user: NoticeUser, kind: NoticeServiceKind): Promise<NoticesView> {
    this.requireAdmin(user);
    const known = (await this.store.services()).some((service) => service.kind === kind);
    await this.store.removeService(kind);
    if (known) {
      logger.info(
        `[Notifications] ${describeActor(user)} removed the ${NOTICE_SERVICE_NAMES[kind]} service with its secret`,
      );
      await recordAudit(this.audit, { actor: user, action: 'notification.service.remove', details: { kind } });
    }
    return this.view(user);
  }

  // -------------------------------------------------------------------- my own

  /**
   * `PUT /api/notifications/me/destinations/:kind`, once the password passed: saves the user's own address on the
   * service, which `destinationAddressProblem` passes, as `storedDestinationAddress` leaves it. The user's first
   * destination ticks the starting topics, unless they saved topics before.
   */
  async saveDestination(user: NoticeUser, kind: NoticeServiceKind, address: unknown): Promise<NoticesView> {
    const problem = destinationAddressProblem(kind, address);
    if (problem !== null) throw new RequestShapeError([problem]);
    const known = (await this.destinationOf(user.userId, kind)) !== undefined;
    await this.store.saveDestination(
      { userId: user.userId, kind },
      storedDestinationAddress(kind, address as string),
      new Date(this.now()),
      STARTING_NOTICE_TOPICS,
    );
    logger.info(
      `[Notifications] ${describeActor(user)} saved their ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()}${
        known ? '' : ', which starts on'
      }`,
    );
    await recordAudit(this.audit, { actor: user, action: 'notification.destination.save', details: { kind } });
    return this.view(user);
  }

  /**
   * `PUT /api/notifications/me/destinations/:kind/enabled`: switches the user's saved destination on or off. Off drops
   * the notices that wait for it. One never saved is a `NoticeDestinationNotSavedError`.
   */
  async setDestinationEnabled(user: NoticeUser, kind: NoticeServiceKind, enabled: boolean): Promise<NoticesView> {
    if (!(await this.store.setDestinationEnabled({ userId: user.userId, kind }, enabled))) {
      throw new NoticeDestinationNotSavedError(kind);
    }
    logger.info(
      `[Notifications] ${describeActor(user)} switched their ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()} ${
        enabled ? 'on' : 'off'
      }`,
    );
    await recordAudit(this.audit, {
      actor: user,
      action: 'notification.destination.enabled',
      details: { kind, enabled },
    });
    return this.view(user);
  }

  /**
   * `DELETE /api/notifications/me/destinations/:kind`: removes the user's destination with the notices that wait for
   * it. One that was not saved stays so, and nothing is audited.
   */
  async removeDestination(user: NoticeUser, kind: NoticeServiceKind): Promise<NoticesView> {
    const known = (await this.destinationOf(user.userId, kind)) !== undefined;
    await this.store.removeDestination({ userId: user.userId, kind });
    if (known) {
      logger.info(
        `[Notifications] ${describeActor(user)} removed their ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()}`,
      );
      await recordAudit(this.audit, { actor: user, action: 'notification.destination.remove', details: { kind } });
    }
    return this.view(user);
  }

  /** `PUT /api/notifications/me/topics`: saves the topics the user gets, which `noticeTopicsProblem` passes. */
  async saveTopics(user: NoticeUser, topics: unknown): Promise<NoticesView> {
    const problem = noticeTopicsProblem(topics);
    if (problem !== null) throw new RequestShapeError([problem]);
    const stored = storedNoticeTopics(topics as string[]);
    await this.store.saveTopics(user.userId, stored, new Date(this.now()));
    logger.info(`[Notifications] ${describeActor(user)} saved their topics: ${stored.join(', ') || 'none'}`);
    await recordAudit(this.audit, { actor: user, action: 'notification.topics.save', details: { topics: stored } });
    return this.view(user);
  }

  /**
   * `POST /api/notifications/me/destinations/:kind/test`: sends the test notice to the user's saved destination, on or
   * off, through the saved service, on or off, and answers whether the service took it. Refused without
   * `BRAND_WALLET_SECRET`, for a destination or a service not saved, and within a minute of the destination's last
   * test. It counts in no rule: how the destination's and the service's notices went, and the waiting notices, stay.
   */
  async test(user: NoticeUser, kind: NoticeServiceKind): Promise<MyNoticeTestResponse> {
    const key = this.requireKey();
    const destinationKey = { userId: user.userId, kind };
    const at = new Date(this.now());
    if (!(await this.destinationOf(user.userId, kind))) throw new NoticeDestinationNotSavedError(kind);
    const service = (await this.store.services()).find((row) => row.kind === kind);
    if (!service) throw new NoticeServiceNotSavedError(kind);

    const claimed = await this.store.claimTest(destinationKey, at, NOTIFICATION_TEST_EVERY_SECONDS);
    // Read after the claim, so the test goes to what is saved now.
    const destination = await this.destinationOf(user.userId, kind);
    if (!destination) throw new NoticeDestinationNotSavedError(kind);
    if (!claimed) throw new NoticeTestTooSoonError(kind, secondsUntilNextTest(destination.lastTestAt, at));

    const outcome = await this.sendTest(service, destination, testNotice(user, at), key);
    await this.store.recordTest(destinationKey, outcome?.error ?? null);
    const where = `their ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()}`;
    if (outcome === null) {
      logger.info(`[Notifications] ${describeActor(user)} sent a test notice to ${where}: it went out`);
    } else {
      logger.warn(
        `[Notifications] ${describeActor(user)} sent a test notice to ${where}: it could not be sent: ${outcome.failure}`,
      );
    }
    await recordAudit(this.audit, {
      actor: user,
      action: 'notification.destination.test',
      details: { kind, sent: outcome === null },
    });
    return { sent: outcome === null, error: outcome?.error ?? null, view: await this.view(user) };
  }

  /**
   * `POST /api/notifications/me/telegram/code`: reads the bot with the saved Telegram service's token, then starts the
   * user's code in place of the one they had, for the user to send to the bot. Refused without `BRAND_WALLET_SECRET`
   * and for a Telegram service not saved. When the bot could not be read, no code is started and the answer says why.
   */
  async telegramCode(user: NoticeUser): Promise<TelegramCodeResponse> {
    const token = await this.telegramToken();
    if ('error' in token) return { code: null, expiresAt: null, bot: null, error: token.error };
    const who = describeActor(user);
    try {
      const bot = await this.lookUpTelegramBot(token.token);
      const code = this.drawCode();
      const expiresAt = new Date(this.now() + TELEGRAM_CHAT_CODE_SECONDS * 1000);
      await this.store.startChatCode(user.userId, code, expiresAt);
      logger.info(`[Notifications] ${who} started a code to find their Telegram chat`);
      return { code, expiresAt: expiresAt.toISOString(), bot, error: null };
    } catch (error) {
      const sentence = this.telegramFailure(error, token.token, `${who} could not start a code`);
      return { code: null, expiresAt: null, bot: null, error: sentence };
    }
  }

  /**
   * `POST /api/notifications/me/telegram/chat`: Find my chat. Reads the bot's latest messages with the saved Telegram
   * service's token for the one chat that sent the user's code, and answers that chat alone. Refused without
   * `BRAND_WALLET_SECRET`, for a Telegram service not saved, and with no code of the user's that holds.
   */
  async telegramChat(user: NoticeUser): Promise<TelegramChatResponse> {
    const token = await this.telegramToken();
    const code = await this.store.chatCode(user.userId, new Date(this.now()));
    if (code === null) throw new TelegramCodeNotStartedError();
    if ('error' in token) return { chat: null, error: token.error };
    const who = describeActor(user);
    try {
      const chat = await this.findTelegramChat(token.token, code);
      logger.info(
        `[Notifications] ${who} looked for their Telegram chat: ${chat ? 'found' : 'none of the latest messages sends the code yet'}`,
      );
      return { chat, error: null };
    } catch (error) {
      return { chat: null, error: this.telegramFailure(error, token.token, `${who} could not look for their chat`) };
    }
  }

  // -------------------------------------------------------------------- helpers

  private requireAdmin(user: NoticeUser): void {
    if (!user.isAdmin) throw new AdminRequiredError();
  }

  /** The key, or a `NotificationsUnavailableError` while the admin has no `BRAND_WALLET_SECRET`. */
  private requireKey(): Buffer {
    if (this.secretKey === null) throw new NotificationsUnavailableError();
    return this.secretKey;
  }

  private async destinationOf(userId: string, kind: NoticeServiceKind): Promise<NoticeDestinationRow | undefined> {
    return (await this.store.destinations(userId)).find((destination) => destination.kind === kind);
  }

  /**
   * The saved Telegram service's token, opened for the one lookup, or why it would not open. Refused without
   * `BRAND_WALLET_SECRET` and for a Telegram service not saved.
   */
  private async telegramToken(): Promise<{ token: string } | { error: string }> {
    const key = this.requireKey();
    const row = (await this.store.services()).find((service) => service.kind === 'telegram');
    if (!row) throw new NoticeServiceNotSavedError('telegram');
    try {
      return { token: openChannelSecret('telegram', row.secret, key) };
    } catch (error) {
      // openChannelSecret's sentences name the service and the setting, never the secret or the key.
      if (error instanceof ChannelSecretError) return { error: error.message };
      logger.error(`[Notifications] the Telegram service's secret could not be opened: ${getErrorMessage(error)}`);
      return { error: TELEGRAM_OWN_ERROR };
    }
  }

  /** What a failed Telegram lookup answers, logged without the token. */
  private telegramFailure(error: unknown, token: string, what: string): string {
    if (error instanceof NotificationSendError) {
      const sentence = withoutSecret(error.message, token);
      logger.warn(`[Notifications] ${what}: ${quoteForLog(sentence)}`);
      return sentence;
    }
    logger.error(
      `[Notifications] ${what}, with an error of the admin's own: ${quoteForLog(withoutSecret(getErrorMessage(error), token))}`,
    );
    return TELEGRAM_OWN_ERROR;
  }

  /**
   * Sends the test notice to the destination through the saved service: null once the service took it, or why it could
   * not, twice over: `error` for its user, which holds no secret, and `failure` for the log, which holds no address.
   */
  private async sendTest(
    service: NoticeServiceRow,
    destination: NoticeDestinationRow,
    notice: Notice,
    key: Buffer,
  ): Promise<{ error: string; failure: string } | null> {
    let secret: string;
    try {
      secret = openChannelSecret(service.kind, service.secret, key);
    } catch (error) {
      if (error instanceof ChannelSecretError) return { error: error.message, failure: error.message };
      logger.error(
        `[Notifications] the ${NOTICE_SERVICE_NAMES[service.kind]} service's secret could not be opened: ${getErrorMessage(error)}`,
      );
      return { error: OWN_ERROR, failure: OWN_ERROR };
    }
    try {
      const config = {
        kind: service.kind,
        settings: service.settings,
        secret,
        address: destination.address,
      } as DestinationChannelConfig;
      await this.channelFrom(config).send(notice);
      return null;
    } catch (error) {
      if (error instanceof NotificationSendError) {
        return { error: withoutSecret(error.message, secret), failure: serviceFailureSentence(service.kind, error) };
      }
      logger.error(
        `[Notifications] a test notice through the ${NOTICE_SERVICE_NAMES[service.kind]} service met an error of the admin's own`,
      );
      return { error: OWN_ERROR, failure: OWN_ERROR };
    }
  }
}
