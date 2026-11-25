/**
 * The channels a notice goes out on, built by {@link channelFrom}: email through its provider, Slack through an
 * incoming webhook, Telegram through a bot. `channel.ts` says what each one sends, and `call.ts` makes the calls.
 */

import { BrevoEmailProvider } from './brevo.js';
import { callService, type NotificationCallOptions } from './call.js';
import {
  NotificationSendError,
  type Channel,
  type ChannelConfig,
  type EmailProvider,
  type NotificationFetch,
} from './channel.js';
import {
  channelSecretProblem,
  noticeProblem,
  SLACK_WEBHOOK_HOST,
  storedChannelSecret,
  TELEGRAM_API_HOST,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  type EmailChannelSettings,
  type EmailProviderKind,
  type Notice,
  type TelegramChannelSettings,
} from './rules.js';

/**
 * The longest text one Slack message is sent with. A longer notice goes as several, cut at line breaks, and its length
 * is counted once `&`, `<` and `>` are escaped.
 *
 * Slack gives a message's length on its reference of `chat.postMessage`,
 * https://docs.slack.dev/reference/methods/chat.postMessage/: a `text` of 4,000 characters at most gives the best
 * results, and a message over 40,000 is cut short. An incoming webhook's message has the same `text`. The 4,000 is the
 * one taken, so a long notice reads on Slack as it does on Telegram, whose limit is 4,096.
 */
export const SLACK_MESSAGE_MAX_LENGTH = 4000;

const SLACK_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** The text with `&`, `<` and `>` written as Slack asks, so nothing in it mentions a person or a channel, or makes a link. */
export function escapeForSlack(text: string): string {
  return text.replace(/[&<>]/g, (character) => SLACK_ESCAPES[character] ?? character);
}

/**
 * A line as rendered pieces of at most `max` characters: the line itself when it fits, and otherwise cut at its last
 * space that fits, or where it has to be. A cut falls between two characters, never inside one or inside what one
 * renders as.
 */
function cutLine(line: string, max: number, render: (text: string) => string): string[] {
  const rendered = render(line);
  if (rendered.length <= max) return [rendered];
  const characters = Array.from(line, (character) => ({ character, rendered: render(character) }));
  const pieces: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start;
    let length = 0;
    while (end < characters.length && length + characters[end].rendered.length <= max) {
      length += characters[end].rendered.length;
      end += 1;
    }
    let cut = end;
    if (end < characters.length) {
      let space = end;
      while (space > start && characters[space].character !== ' ') space -= 1;
      if (space > start) cut = space;
    }
    // A character that renders longer than a whole part goes on its own.
    if (cut === start) cut = start + 1;
    const piece = characters
      .slice(start, cut)
      .map((character) => character.rendered)
      .join('')
      .trimEnd();
    if (piece !== '') pieces.push(piece);
    start = cut;
    while (start < characters.length && characters[start].character === ' ') start += 1;
  }
  return pieces;
}

/**
 * The text, rendered, in parts of at most `max` characters, cut at line breaks: each part holds as many whole lines as
 * fit, and a line too long for a part of its own is cut at its last space that fits, or where it has to be. The blank
 * lines at a cut are dropped. A text that fits is one part, as it is.
 *
 * `render` takes one character at a time, as escaping does, so a part is measured as it is sent, and a cut never falls
 * inside what one character renders as.
 */
export function cutAtLineBreaks(text: string, max: number, render: (text: string) => string = (raw) => raw): string[] {
  const whole = render(text);
  if (whole.length <= max) return [whole];
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
    for (const piece of cutLine(line, max, render)) {
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

/** How each email service's provider is made from the channel's secret: one entry for each of `EMAIL_PROVIDER_KINDS`. */
const EMAIL_PROVIDERS: {
  readonly [K in EmailProviderKind]: (apiKey: string, options: NotificationCallOptions) => EmailProvider;
} = {
  brevo: (apiKey, options) => new BrevoEmailProvider(apiKey, options),
};

/** The provider of the service the settings name, or null for a service this package does not have. */
function emailProviderFrom(kind: string, apiKey: string, options: NotificationCallOptions): EmailProvider | null {
  return Object.hasOwn(EMAIL_PROVIDERS, kind) ? EMAIL_PROVIDERS[kind as EmailProviderKind](apiKey, options) : null;
}

/** Email: the title is the subject, the text is the body, and the provider the settings name sends it. */
class EmailChannel implements Channel {
  readonly kind = 'email';
  readonly #settings: EmailChannelSettings;
  readonly #provider: EmailProvider | null;

  constructor(settings: EmailChannelSettings, provider: EmailProvider | null) {
    this.#settings = settings;
    this.#provider = provider;
  }

  async send(notice: Notice): Promise<void> {
    checkNotice(notice);
    if (this.#provider === null) {
      throw new NotificationSendError("The email channel's service is not one a notice can go out through.");
    }
    await this.#provider.send({
      senderAddress: this.#settings.senderAddress,
      senderName: this.#settings.senderName,
      recipients: this.#settings.recipients,
      subject: notice.title,
      text: notice.text,
    });
  }
}

/** Slack: `{ text }` posted to the incoming webhook, the title in bold, then an empty line, then the text. */
class SlackChannel implements Channel {
  readonly kind = 'slack';
  // The language's private fields rather than TypeScript's, so no view of the object shows the webhook's URL.
  readonly #webhookUrl: string;
  readonly #fetch: NotificationFetch | undefined;

  constructor(webhookUrl: string, options: NotificationCallOptions) {
    this.#webhookUrl = webhookUrl;
    this.#fetch = options.fetch;
  }

  async send(notice: Notice): Promise<void> {
    checkNotice(notice);
    const webhookUrl = storedChannelSecret(this.#webhookUrl);
    if (channelSecretProblem('slack', webhookUrl) !== null) {
      throw new NotificationSendError(
        `The webhook's URL is not an incoming webhook on ${SLACK_WEBHOOK_HOST}, so Slack was not called.`,
      );
    }
    // The call goes to Slack's host with the path the URL names. The URL is the secret, and the three parts of its
    // path are cut out of Slack's words as well.
    const path = new URL(webhookUrl).pathname;
    const secrets = [webhookUrl, ...path.split('/').slice(2)];
    const parts = cutAtLineBreaks(
      `*${notice.title.trim()}*\n\n${notice.text}`,
      SLACK_MESSAGE_MAX_LENGTH,
      escapeForSlack,
    );
    await sendInOrder(parts, (text) =>
      callService({ service: 'Slack', host: SLACK_WEBHOOK_HOST, path, body: { text }, secrets }, this.#fetch),
    );
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

  constructor(settings: TelegramChannelSettings, token: string, options: NotificationCallOptions) {
    this.#chatId = settings.chatId;
    this.#token = token;
    this.#fetch = options.fetch;
  }

  async send(notice: Notice): Promise<void> {
    checkNotice(notice);
    const token = storedChannelSecret(this.#token);
    if (channelSecretProblem('telegram', token) !== null) {
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
 * Builds the channel that a saved channel's kind, settings and secret describe: the `ChannelFactory` the admin sends
 * its notices through. It makes no call. A channel whose secret no longer passes `channelSecretProblem` calls
 * nothing and fails its sends.
 */
export function channelFrom(config: ChannelConfig, options: NotificationCallOptions = {}): Channel {
  switch (config.kind) {
    case 'email':
      return new EmailChannel(config.settings, emailProviderFrom(config.settings.provider, config.secret, options));
    case 'slack':
      return new SlackChannel(config.secret, options);
    case 'telegram':
      return new TelegramChannel(config.settings, config.secret, options);
  }
}
