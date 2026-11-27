/**
 * The rules of a notice, of each service's settings and of a person's destination on it, which the backend that sends
 * and the console whose forms take them have to agree on. Nothing here imports node, so a browser bundle can read it.
 *
 * A service is one way a notice reaches people: email, or a Telegram bot. Each has settings, which a view may show, and
 * one secret, which nothing shows: the email service's API key, Telegram's bot token. A destination is where one
 * person's notices go on a service. `docs/architecture/notifications.md` is the design.
 */

// ---------------------------------------------------------------- the notice

/** A notice: what one message to people says, on whichever service it goes out. Plain text, with no markup. */
export interface Notice {
  /** One line: an email's subject, and a chat message's first line. */
  title: string;
  /** What it says, in plain text with line breaks. */
  text: string;
}

/** The longest a notice's title is. */
export const NOTICE_TITLE_MAX_LENGTH = 200;

/** Why this cannot go out as a notice, in a sentence, or null. */
export function noticeProblem(notice: Notice): string | null {
  if (notice.title.trim() === '') return 'A notice has a title.';
  if (/[\r\n]/.test(notice.title)) return "A notice's title is one line.";
  if (notice.title.length > NOTICE_TITLE_MAX_LENGTH) {
    return `A notice's title is at most ${NOTICE_TITLE_MAX_LENGTH} characters.`;
  }
  if (notice.text.trim() === '') return 'A notice has a text.';
  return null;
}

// ------------------------------------------------------- the outbound calls

/** The hosts the services are called on, each over https on port 443. They are fixed here: no setting names a host. */
export const BREVO_API_HOST = 'api.brevo.com';
export const TELEGRAM_API_HOST = 'api.telegram.org';

/** How long one call to a service may take from its start to the end of its answer. */
export const NOTIFICATION_CALL_TIMEOUT_MS = 10_000;

/** The most of a service's answer that is read. */
export const NOTIFICATION_ANSWER_MAX_BYTES = 16 * 1024;

/** The most of a service's own words a failure's sentence repeats. */
export const NOTIFICATION_SERVICE_WORDS_MAX_LENGTH = 200;

/** The longest text Telegram takes in one message. A longer notice goes as several. */
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

// ---------------------------------------------------------------- the secret

/** The longest a service's secret is. */
export const NOTIFICATION_SECRET_MAX_LENGTH = 512;

/** One line of printable characters with no space, as a service hands a key out. */
const API_KEY_PATTERN = /^[\x21-\x7e]{20,512}$/;

/** A Telegram bot's token: the bot's numeric id, a colon, and its key. */
const TELEGRAM_TOKEN_PATTERN = /^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$/;

/** A secret as it is checked and kept: trimmed. */
export function storedChannelSecret(secret: string): string {
  return secret.trim();
}

// ----------------------------------------------------------------- the email

/** The email providers the email service can send through. */
export const EMAIL_PROVIDER_KINDS = ['brevo'] as const;
export type EmailProviderKind = (typeof EMAIL_PROVIDER_KINDS)[number];

/** What a view calls each email service. */
export const EMAIL_PROVIDER_NAMES: Readonly<Record<EmailProviderKind, string>> = { brevo: 'Brevo' };

/** The longest an email address is. */
export const EMAIL_ADDRESS_MAX_LENGTH = 254;

/** The longest the sender's name is. */
export const EMAIL_SENDER_NAME_MAX_LENGTH = 70;

const EMAIL_PATTERN = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\.]+$/;

/** Printable characters and spaces with no quotation mark, angle bracket or backslash: what a mail's From line takes. */
const SENDER_NAME_PATTERN = /^[^\x00-\x1f\x7f"<>\\]*$/;

/** An address as it is kept: trimmed, in lower case. */
export function storedEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

/** Why a typed address is refused, in a sentence, or null. */
export function emailAddressProblem(value: string): string | null {
  const email = storedEmailAddress(value);
  if (email === '') return 'Enter an email address.';
  if (email.length > EMAIL_ADDRESS_MAX_LENGTH) {
    return `An email address is at most ${EMAIL_ADDRESS_MAX_LENGTH} characters.`;
  }
  if (!EMAIL_PATTERN.test(email)) return 'Enter an email address such as name@example.org.';
  return null;
}

// ----------------------------------------------------------------- the chats

/** A chat's numeric id: a whole number, negative for a group, with no leading zero. */
const TELEGRAM_CHAT_NUMBER_PATTERN = /^-?[1-9][0-9]{0,18}$/;

/** A public channel's or group's name: `@`, a letter, then letters, digits and underscores, 5 to 32 in all. */
const TELEGRAM_CHAT_NAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** The kinds of Telegram chat, as the Bot API names them: a person's own chat with the bot, a group, a channel. */
export const TELEGRAM_CHAT_KINDS = ['private', 'group', 'supergroup', 'channel'] as const;
export type TelegramChatKind = (typeof TELEGRAM_CHAT_KINDS)[number];

export function isTelegramChatKind(value: unknown): value is TelegramChatKind {
  return (TELEGRAM_CHAT_KINDS as readonly unknown[]).includes(value);
}

/** The longest a chat's name is shown. */
export const TELEGRAM_CHAT_NAME_MAX_LENGTH = 160;

/** The chat that sent a person's code to the bot, as Find my chat finds it: what their Telegram destination is set to. */
export interface TelegramChat {
  /** Its numeric id as a destination takes it: positive for a person's own chat, negative for a group or channel. */
  id: string;
  kind: TelegramChatKind;
  /**
   * The person's name, or the group's or channel's title, then its `@username` when it has one; one line of at most
   * {@link TELEGRAM_CHAT_NAME_MAX_LENGTH} characters, and empty when Telegram gave neither.
   */
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------- the services and the destinations

/**
 * The services a notice goes out through, in the order a view lists them: an email service, and a Telegram bot. One
 * of each serves everyone. Its settings and its secret are the shared part, which a view may show and nothing shows:
 * the email service's sender and its API key, and the Telegram bot's token.
 */
export const NOTICE_SERVICE_KINDS = ['email', 'telegram'] as const;
export type NoticeServiceKind = (typeof NOTICE_SERVICE_KINDS)[number];

export function isNoticeServiceKind(value: unknown): value is NoticeServiceKind {
  return (NOTICE_SERVICE_KINDS as readonly unknown[]).includes(value);
}

/** What a view calls each service. */
export const NOTICE_SERVICE_NAMES: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'Email',
  telegram: 'Telegram',
};

/** What each service's secret is, as a form names its field. */
export const NOTICE_SERVICE_SECRET_NAMES: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'API key',
  telegram: 'Bot token',
};

/** The email service's settings. Its secret is the service's API key. */
export interface EmailServiceSettings {
  /** The service the mails go through. */
  provider: EmailProviderKind;
  /** The address the mails come from, one the service sends for. Trimmed, in lower case. */
  senderAddress: string;
  /** The name shown beside that address, or empty for none. */
  senderName: string;
}

/** The Telegram service's settings: none. Its secret is the bot's token. */
export type TelegramServiceSettings = Record<string, never>;

/** Each service's settings, by its kind. */
export interface NoticeServiceSettingsByKind {
  email: EmailServiceSettings;
  telegram: TelegramServiceSettings;
}

export type NoticeServiceSettings = NoticeServiceSettingsByKind[NoticeServiceKind];

/**
 * Why these cannot be the service's settings, a sentence each, or an empty list when they can be saved. It takes what
 * a request's body holds, of any shape.
 */
export function serviceSettingsProblems(kind: NoticeServiceKind, settings: unknown): string[] {
  if (!isRecord(settings)) return [`The ${NOTICE_SERVICE_NAMES[kind]} settings are missing.`];
  switch (kind) {
    case 'email': {
      const problems: string[] = [];
      if (!(EMAIL_PROVIDER_KINDS as readonly unknown[]).includes(settings.provider)) {
        problems.push(`The email service is one of: ${EMAIL_PROVIDER_KINDS.join(', ')}.`);
      }
      if (typeof settings.senderAddress !== 'string') {
        problems.push('Enter the sender address.');
      } else {
        const problem = emailAddressProblem(settings.senderAddress);
        if (problem !== null) problems.push(`The sender address: ${problem}`);
      }
      if (
        typeof settings.senderName !== 'string' ||
        settings.senderName.trim().length > EMAIL_SENDER_NAME_MAX_LENGTH ||
        !SENDER_NAME_PATTERN.test(settings.senderName)
      ) {
        problems.push(
          `The sender's name is one line of at most ${EMAIL_SENDER_NAME_MAX_LENGTH} characters, with no quotation mark, angle bracket or backslash.`,
        );
      }
      return problems;
    }
    case 'telegram':
      return [];
  }
}

/**
 * The settings as they are kept, once {@link serviceSettingsProblems} found nothing: the sender's address trimmed and
 * in lower case, its name trimmed, and nothing a form sent beside them.
 */
export function storedServiceSettings<K extends NoticeServiceKind>(
  kind: K,
  settings: NoticeServiceSettingsByKind[K],
): NoticeServiceSettingsByKind[K];
export function storedServiceSettings(kind: NoticeServiceKind, settings: NoticeServiceSettings): NoticeServiceSettings {
  switch (kind) {
    case 'email': {
      const email = settings as EmailServiceSettings;
      return {
        provider: email.provider,
        senderAddress: storedEmailAddress(email.senderAddress),
        senderName: email.senderName.trim(),
      };
    }
    case 'telegram':
      return {};
  }
}

/** Why this cannot be the service's secret, in a sentence that never repeats it, or null. A secret is kept trimmed. */
export function serviceSecretProblem(kind: NoticeServiceKind, secret: string): string | null {
  const value = storedChannelSecret(secret);
  if (value.length > NOTIFICATION_SECRET_MAX_LENGTH) {
    return `The ${NOTICE_SERVICE_SECRET_NAMES[kind].toLowerCase()} is at most ${NOTIFICATION_SECRET_MAX_LENGTH} characters.`;
  }
  switch (kind) {
    case 'email':
      return API_KEY_PATTERN.test(value)
        ? null
        : 'Enter the API key the email service gave: one line of 20 characters or more, with no space.';
    case 'telegram':
      return TELEGRAM_TOKEN_PATTERN.test(value)
        ? null
        : "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key.";
  }
}

/**
 * A destination is where one person's notices go on one service, as one line of text: for email the person's address,
 * and for Telegram the id of the chat the bot writes to, a whole number, negative for a group, or a public channel's
 * name with its `@`. This is what a view calls each.
 */
export const NOTICE_DESTINATION_NAMES: Readonly<Record<NoticeServiceKind, string>> = {
  email: 'Email address',
  telegram: 'Telegram chat',
};

/** A destination's address as it is kept: trimmed, and an email address in lower case. */
export function storedDestinationAddress(kind: NoticeServiceKind, address: string): string {
  return kind === 'email' ? storedEmailAddress(address) : address.trim();
}

/** Why this cannot be a destination on the service, in a sentence, or null. It takes what a request's body holds. */
export function destinationAddressProblem(kind: NoticeServiceKind, address: unknown): string | null {
  if (typeof address !== 'string') return `Enter the ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()}.`;
  switch (kind) {
    case 'email':
      return emailAddressProblem(address);
    case 'telegram': {
      const chatId = address.trim();
      return TELEGRAM_CHAT_NUMBER_PATTERN.test(chatId) || TELEGRAM_CHAT_NAME_PATTERN.test(chatId)
        ? null
        : "The chat id is a whole number, such as 123456789 for your own chat with the bot, or a public channel's name, such as @channelname.";
    }
  }
}

// ------------------------------------------------------- finding one's chat

/**
 * A Telegram bot as the Bot API's `getMe` names it: the bot a person writes to, so that it can write to them.
 * https://core.telegram.org/bots/api#getme
 */
export interface TelegramBot {
  /** Its username, with no `@`: the name in its `t.me` link. */
  username: string;
  /** The name it shows in a chat, one line of at most {@link TELEGRAM_CHAT_NAME_MAX_LENGTH} characters. */
  name: string;
}

/** A bot's username: a letter, then letters, digits and underscores, 5 to 32 in all. */
const TELEGRAM_BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function isTelegramBotUsername(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_BOT_USERNAME_PATTERN.test(value);
}

/**
 * The code a person sends to the bot from the chat their notices are to go to, so that the chat can be told from every
 * other one that wrote to the bot. It is drawn at random for one person and holds for a short while, and it tells
 * nothing by itself.
 */
export const TELEGRAM_CHAT_CODE_LENGTH = 10;

/** The characters a code is drawn from: capital letters and digits, without the ones read for one another. */
export const TELEGRAM_CHAT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const TELEGRAM_CHAT_CODE_PATTERN = new RegExp(`^[${TELEGRAM_CHAT_CODE_ALPHABET}]{${TELEGRAM_CHAT_CODE_LENGTH}}$`);

export function isTelegramChatCode(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_CHAT_CODE_PATTERN.test(value);
}

/**
 * Whether a message's text sends this code: the code alone, or after `/start`, which is what Telegram sends when a
 * person opens {@link telegramStartLink} and presses Start, in a group with the bot's name after the command. Spaces
 * around it and the case of its letters make no difference.
 */
export function telegramTextSendsCode(text: string, code: string): boolean {
  const said = text.trim().replace(/^\/start(@[A-Za-z0-9_]+)?\s+/i, '');
  return isTelegramChatCode(code) && said.toUpperCase() === code;
}

/**
 * The link that opens a person's own chat with the bot and, once they press Start, sends the code from it.
 * https://core.telegram.org/bots/features#deep-linking
 */
export function telegramStartLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}
