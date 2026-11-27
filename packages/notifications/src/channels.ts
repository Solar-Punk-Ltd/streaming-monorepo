/**
 * The channels a notice goes out on, each to one person's destination, built by {@link destinationChannelFrom}: email
 * through its provider, Telegram through a bot. `channel.ts` says what each one sends, and `call.ts` makes the calls.
 */

import { BrevoEmailProvider } from './brevo.js';
import { callService, type NotificationCallOptions } from './call.js';
import {
  NotificationSendError,
  type Channel,
  type DestinationChannelConfig,
  type EmailProvider,
  type NotificationFetch,
} from './channel.js';
import {
  noticeProblem,
  serviceSecretProblem,
  storedChannelSecret,
  TELEGRAM_API_HOST,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  type EmailProviderKind,
  type EmailServiceSettings,
  type Notice,
} from './rules.js';

/**
 * A line as pieces of at most `max` characters: the line itself when it fits, and otherwise cut at its last space that
 * fits, or where it has to be. A cut falls between two characters, never inside one.
 */
function cutLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const characters = Array.from(line);
  const pieces: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start;
    let length = 0;
    while (end < characters.length && length + characters[end].length <= max) {
      length += characters[end].length;
      end += 1;
    }
    let cut = end;
    if (end < characters.length) {
      let space = end;
      while (space > start && characters[space] !== ' ') space -= 1;
      if (space > start) cut = space;
    }
    // A character longer than a whole part goes on its own.
    if (cut === start) cut = start + 1;
    const piece = characters.slice(start, cut).join('').trimEnd();
    if (piece !== '') pieces.push(piece);
    start = cut;
    while (start < characters.length && characters[start] === ' ') start += 1;
  }
  return pieces;
}

/**
 * The text in parts of at most `max` characters, cut at line breaks: each part holds as many whole lines as fit, and a
 * line too long for a part of its own is cut at its last space that fits, or where it has to be. The blank lines at a
 * cut are dropped. A text that fits is one part, as it is.
 */
export function cutAtLineBreaks(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let lines: string[] = [];
  let length = 0;
  const close = () => {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) parts.push(lines.join('\n'));
    lines = [];
    length = 0;
  };
  for (const line of text.split('\n')) {
    for (const piece of cutLine(line, max)) {
      if (lines.length > 0 && length + 1 + piece.length > max) close();
      if (lines.length === 0 && piece.trim() === '') continue;
      length += (lines.length === 0 ? 0 : 1) + piece.length;
      lines.push(piece);
    }
  }
  close();
  return parts;
}

/**
 * Sends a notice's parts one after the other. The notice is taken once every part is, and the first part that fails
 * ends it, saying how many went out before it.
 */
async function sendInOrder(parts: readonly string[], send: (part: string) => Promise<void>): Promise<void> {
  for (const [index, part] of parts.entries()) {
    try {
      await send(part);
    } catch (error) {
      if (index === 0 || !(error instanceof NotificationSendError)) throw error;
      throw new NotificationSendError(
        `${index} of the notice's ${parts.length} messages went out, then: ${error.message}`,
        {
          status: error.status,
          cause: error,
        },
      );
    }
  }
}

/** Throws the sentence of `noticeProblem` for a notice that cannot go out. */
function checkNotice(notice: Notice): void {
  const problem = noticeProblem(notice);
  if (problem !== null) throw new NotificationSendError(problem);
}

/** How each email provider is made from the service's secret: one entry for each of `EMAIL_PROVIDER_KINDS`. */
const EMAIL_PROVIDERS: {
  readonly [K in EmailProviderKind]: (apiKey: string, options: NotificationCallOptions) => EmailProvider;
} = {
  brevo: (apiKey, options) => new BrevoEmailProvider(apiKey, options),
};

/** The provider the settings name, or null for a provider this package does not have. */
function emailProviderFrom(kind: string, apiKey: string, options: NotificationCallOptions): EmailProvider | null {
  return Object.hasOwn(EMAIL_PROVIDERS, kind) ? EMAIL_PROVIDERS[kind as EmailProviderKind](apiKey, options) : null;
}

/**
 * Email: the title is the subject, the text is the body, and the provider the settings name sends it from the
 * service's sender to the one address.
 */
class EmailChannel implements Channel {
  readonly kind = 'email';
  readonly #sender: EmailServiceSettings;
  readonly #address: string;
  readonly #provider: EmailProvider | null;

  constructor(sender: EmailServiceSettings, address: string, provider: EmailProvider | null) {
    this.#sender = sender;
    this.#address = address;
    this.#provider = provider;
  }

  async send(notice: Notice): Promise<void> {
    checkNotice(notice);
    if (this.#provider === null) {
      throw new NotificationSendError("The email channel's service is not one a notice can go out through.");
    }
    await this.#provider.send({
      senderAddress: this.#sender.senderAddress,
      senderName: this.#sender.senderName,
      recipients: [this.#address],
      subject: notice.title,
      text: notice.text,
    });
  }
}

/**
 * Telegram: `sendMessage` with the chat's id and the title, an empty line and the text, with no `parse_mode` and with
 * link previews off. https://core.telegram.org/bots/api#sendmessage
 */
class TelegramChannel implements Channel {
  readonly kind = 'telegram';
  readonly #chatId: string;
  // The language's private fields rather than TypeScript's, so no view of the object shows the token.
  readonly #token: string;
  readonly #fetch: NotificationFetch | undefined;

  constructor(chatId: string, token: string, options: NotificationCallOptions) {
    this.#chatId = chatId;
    this.#token = token;
    this.#fetch = options.fetch;
  }

  async send(notice: Notice): Promise<void> {
    checkNotice(notice);
    const token = storedChannelSecret(this.#token);
    if (serviceSecretProblem('telegram', token) !== null) {
      throw new NotificationSendError("The bot's token is not one BotFather gives out, so Telegram was not called.");
    }
    const path = `/bot${token}/sendMessage`;
    // The token is the secret, and the part after its colon is the bot's key.
    const secrets = [token, token.slice(token.indexOf(':') + 1)];
    const parts = cutAtLineBreaks(`${notice.title}\n\n${notice.text}`, TELEGRAM_MESSAGE_MAX_LENGTH);
    await sendInOrder(parts, (text) =>
      callService(
        {
          service: 'Telegram',
          host: TELEGRAM_API_HOST,
          path,
          body: { chat_id: this.#chatId, text, link_preview_options: { is_disabled: true } },
          secrets,
        },
        this.#fetch,
      ),
    );
  }
}

/**
 * Builds the channel a notice reaches one person on, from the service's kind, settings and secret and the person's
 * destination: the `DestinationChannelFactory` the admin sends each person's notice through. It makes no call.
 *
 * - **email** sends one mail, from the service's sender, to the destination's address alone, so two people's notices
 *   are two mails and neither names the other.
 * - **telegram** sends to the chat whose id the destination is.
 *
 * A channel whose secret no longer passes `serviceSecretProblem` calls nothing and fails its sends.
 */
export function destinationChannelFrom(
  config: DestinationChannelConfig,
  options: NotificationCallOptions = {},
): Channel {
  switch (config.kind) {
    case 'email':
      return new EmailChannel(
        config.settings,
        config.address,
        emailProviderFrom(config.settings.provider, config.secret, options),
      );
    case 'telegram':
      return new TelegramChannel(config.address, config.secret, options);
  }
}
