/**
 * What a notice goes out through: a channel for each kind, and under the email channel a provider for each email
 * service. A caller builds a channel from its settings and its secret with a {@link ChannelFactory} and hands it a
 * notice. Nothing here keeps settings, decides when a notice goes out, or knows what one is about.
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
  EmailChannelSettings,
  EmailProviderKind,
  Notice,
  NotificationChannelKind,
  SlackChannelSettings,
  TelegramChannelSettings,
} from './rules.js';

/**
 * Why a notice could not be sent, in a sentence a view shows: what failed, the service's status, and up to
 * `NOTIFICATION_SERVICE_WORDS_MAX_LENGTH` printable characters of the service's own words. It never carries the
 * channel's secret or the address that was called, since Telegram's address holds the bot's token and Slack's is the
 * secret itself.
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
 * One channel, ready to send. `send` resolves once the service took the notice, and rejects with a
 * {@link NotificationSendError}.
 *
 * - **email** hands the notice to its {@link EmailProvider}: the subject is the title and the body is the text.
 * - **slack** posts `{ "text": … }` to the webhook: the title between asterisks, an empty line, the text. In both, `&`,
 *   `<` and `>` are written `&amp;`, `&lt;` and `&gt;`, so nothing in a notice mentions a person or a channel or
 *   makes a link.
 * - **telegram** posts `sendMessage` with the chat id and the text, with no `parse_mode` and with link previews off:
 *   the title, an empty line, the text. A notice over `TELEGRAM_MESSAGE_MAX_LENGTH` characters goes as several
 *   messages, cut at line breaks and sent in order, and it is taken once every one of them is.
 */
export interface Channel {
  readonly kind: NotificationChannelKind;
  send(notice: Notice): Promise<void>;
}

/** One mail as a provider sends it: plain text, nothing attached. */
export interface OutgoingEmail {
  senderAddress: string;
  /** Empty for none. */
  senderName: string;
  /** One or more. Every recipient is named in the one mail. */
  recipients: readonly string[];
  subject: string;
  text: string;
}

/**
 * One email service. `send` resolves once the service took the mail, and rejects with a
 * {@link NotificationSendError}. A service is added by one class of this shape and its entry in
 * `EMAIL_PROVIDER_KINDS`; the email channel stays as it is.
 *
 * **brevo** posts to `https://api.brevo.com/v3/smtp/email` with the key in the `api-key` header and
 * `{ sender: { email, name }, to: [{ email }], subject, textContent }`.
 */
export interface EmailProvider {
  readonly kind: EmailProviderKind;
  send(email: OutgoingEmail): Promise<void>;
}

/** What a channel is built from: its kind, its settings and its secret. */
export type ChannelConfig =
  | { kind: 'email'; settings: EmailChannelSettings; secret: string }
  | { kind: 'slack'; settings: SlackChannelSettings; secret: string }
  | { kind: 'telegram'; settings: TelegramChannelSettings; secret: string };

/**
 * Builds a channel. It makes no call and checks nothing with the service: the settings and the secret passed
 * `channelSettingsProblems` and `channelSecretProblem` when they were saved.
 */
export type ChannelFactory = (config: ChannelConfig) => Channel;

/** `fetch`, as the channels call it. A test hands in its own. */
export type NotificationFetch = typeof fetch;
