/**
 * What a notice goes out through: a channel to one person's destination on each service, and under the email service a
 * provider for each email provider kind. A caller builds a channel from the service's settings and secret and the
 * person's destination with a {@link DestinationChannelFactory} and hands it a notice. Nothing here keeps settings,
 * decides when a notice goes out, or knows what one is about.
 *
 * Every call a channel makes follows the same rules:
 *
 * - `POST` over https to a host fixed in `rules.ts`, with a JSON body.
 * - No redirect is followed.
 * - It ends after `NOTIFICATION_CALL_TIMEOUT_MS`, and at most `NOTIFICATION_ANSWER_MAX_BYTES` of the answer are read.
 * - One notice is one call, or for Telegram one call for each message a long notice is cut into. Nothing is tried
 *   again here: the caller decides when to.
 * - The text is sent as plain text. No part of a notice is read as markup.
 */

import type {
  EmailProviderKind,
  EmailServiceSettings,
  Notice,
  NoticeServiceKind,
  TelegramBot,
  TelegramChat,
  TelegramServiceSettings,
} from './rules.js';

/**
 * Why a notice could not be sent, in a sentence a view shows: what failed, the service's status, and up to
 * `NOTIFICATION_SERVICE_WORDS_MAX_LENGTH` printable characters of the service's own words. It never carries the
 * service's secret or the address that was called, since Telegram's address holds the bot's token.
 */
export class NotificationSendError extends Error {
  /** The HTTP status the service answered with, or null when no answer came. */
  readonly status: number | null;

  constructor(message: string, options?: { status?: number | null; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NotificationSendError';
    this.status = options?.status ?? null;
  }
}

/**
 * One channel to one destination, ready to send. `send` resolves once the service took the notice, and rejects with a
 * {@link NotificationSendError}.
 *
 * - **email** hands the notice to its {@link EmailProvider}: the subject is the title and the body is the text.
 * - **telegram** posts `sendMessage` with the chat id and the text, with no `parse_mode` and with link previews off:
 *   the title, an empty line, the text. A notice over `TELEGRAM_MESSAGE_MAX_LENGTH` characters goes as several
 *   messages, cut at line breaks and sent in order, and it is taken once every one of them is.
 *
 * When a later message of a notice fails, `send` rejects although the earlier ones went out, and the caller's next try
 * sends the notice whole again.
 */
export interface Channel {
  readonly kind: NoticeServiceKind;
  send(notice: Notice): Promise<void>;
}

/** One mail as a provider sends it: plain text, nothing attached. */
export interface OutgoingEmail {
  senderAddress: string;
  /** Empty for none. */
  senderName: string;
  /** One or more. Every recipient is named in the one mail. A destination's channel names its one address. */
  recipients: readonly string[];
  subject: string;
  text: string;
}

/**
 * One email provider. `send` resolves once the provider took the mail, and rejects with a
 * {@link NotificationSendError}. A provider is added by one class of this shape and its entry in
 * `EMAIL_PROVIDER_KINDS`; the email channel stays as it is.
 *
 * **brevo** posts to `https://api.brevo.com/v3/smtp/email` with the key in the `api-key` header and
 * `{ sender: { email, name }, to: [{ email }], subject, textContent }`.
 */
export interface EmailProvider {
  readonly kind: EmailProviderKind;
  send(email: OutgoingEmail): Promise<void>;
}

/** `fetch`, as the channels call it. A test hands in its own. */
export type NotificationFetch = typeof fetch;

/**
 * What a channel to one person is built from: the service's kind, its settings and its secret, which everyone shares,
 * and the person's own destination on it.
 */
export type DestinationChannelConfig =
  | { kind: 'email'; settings: EmailServiceSettings; secret: string; address: string }
  | { kind: 'telegram'; settings: TelegramServiceSettings; secret: string; address: string };

/**
 * Builds the channel a notice reaches one person on. It makes no call and checks nothing with the service: the
 * settings, the secret and the address passed `serviceSettingsProblems`, `serviceSecretProblem` and
 * `destinationAddressProblem` when they were saved.
 *
 * - **email** sends one mail to the one address: the subject is the title and the body is the text. Two people's
 *   notices are two mails, and neither names the other.
 * - **telegram** posts `sendMessage` to the chat whose id the address is, as {@link Channel} says.
 */
export type DestinationChannelFactory = (config: DestinationChannelConfig) => Channel;

/**
 * Reads the bot a token is of, with the Bot API's `getMe`. Rejects with a {@link NotificationSendError} whose sentence
 * never holds the token: for a token BotFather would not give out, without calling Telegram, for Telegram's refusal,
 * and for an answer that is not a bot's.
 */
export type TelegramBotLookup = (token: string) => Promise<TelegramBot>;

/**
 * Finds the chat that sent a code to the bot whose token this is, or null when none of the bot's latest updates holds
 * it. It reads the Bot API's `getUpdates` and answers the chat of the latest message whose text sends the code
 * (`telegramTextSendsCode`). It answers that one chat and never a list, so a person finds their own chat and learns of
 * no other. Rejects with a {@link NotificationSendError} whose sentence never holds the token, as
 * {@link TelegramBotLookup} does, and for a code `isTelegramChatCode` refuses, without calling Telegram.
 */
export type TelegramChatLookup = (token: string, code: string) => Promise<TelegramChat | null>;
