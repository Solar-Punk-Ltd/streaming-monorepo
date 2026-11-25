/**
 * The rules of a notice and of each channel's settings, which the backend that sends and the console whose forms take
 * the settings have to agree on. Nothing here imports node, so a browser bundle can read it.
 *
 * A channel is one way a notice reaches people: email, a Slack channel, a Telegram chat. Each has settings, which a
 * view may show, and one secret, which nothing shows: the email service's API key, Slack's webhook URL, Telegram's bot
 * token. `docs/architecture/notifications.md` is the design.
 */

// ---------------------------------------------------------------- the notice

/** A notice: what one message to people says, on whichever channel it goes out. Plain text, with no markup. */
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

// -------------------------------------------------------------- the channels

/** The channels a notice can go out on, in the order a view lists them. */
export const NOTIFICATION_CHANNEL_KINDS = ['email', 'slack', 'telegram'] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

export function isNotificationChannelKind(value: unknown): value is NotificationChannelKind {
  return (NOTIFICATION_CHANNEL_KINDS as readonly unknown[]).includes(value);
}

/** What a view calls each channel. */
export const NOTIFICATION_CHANNEL_NAMES: Readonly<Record<NotificationChannelKind, string>> = {
  email: 'Email',
  slack: 'Slack',
  telegram: 'Telegram',
};

/** What each channel's secret is, as a form names its field. */
export const NOTIFICATION_SECRET_NAMES: Readonly<Record<NotificationChannelKind, string>> = {
  email: 'API key',
  slack: 'Webhook URL',
  telegram: 'Bot token',
};

// ------------------------------------------------------- the outbound calls

/**
 * The hosts the channels call, each over https on port 443. They are fixed here: a channel's settings never name a
 * host, and Slack's webhook URL is taken only on Slack's.
 */
export const BREVO_API_HOST = 'api.brevo.com';
export const SLACK_WEBHOOK_HOST = 'hooks.slack.com';
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

/** The longest a channel's secret is. */
export const NOTIFICATION_SECRET_MAX_LENGTH = 512;

/** One line of printable characters with no space, as a service hands a key out. */
const API_KEY_PATTERN = /^[\x21-\x7e]{20,512}$/;

/** An incoming webhook of a Slack app: Slack's host, and the three parts Slack names it by. */
const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

/** A Telegram bot's token: the bot's numeric id, a colon, and its key. */
const TELEGRAM_TOKEN_PATTERN = /^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$/;

/** A secret as it is checked and kept: trimmed. */
export function storedChannelSecret(secret: string): string {
  return secret.trim();
}

/** Why this cannot be the channel's secret, in a sentence that never repeats it, or null. */
export function channelSecretProblem(kind: NotificationChannelKind, secret: string): string | null {
  const value = storedChannelSecret(secret);
  if (value.length > NOTIFICATION_SECRET_MAX_LENGTH) {
    return `The ${NOTIFICATION_SECRET_NAMES[kind].toLowerCase()} is at most ${NOTIFICATION_SECRET_MAX_LENGTH} characters.`;
  }
  switch (kind) {
    case 'email':
      return API_KEY_PATTERN.test(value)
        ? null
        : 'Enter the API key the email service gave: one line of 20 characters or more, with no space.';
    case 'slack':
      return SLACK_WEBHOOK_PATTERN.test(value)
        ? null
        : `Enter an incoming webhook's URL from Slack: https://${SLACK_WEBHOOK_HOST}/services/ and its three parts.`;
    case 'telegram':
      return TELEGRAM_TOKEN_PATTERN.test(value)
        ? null
        : "Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key.";
  }
}

// ----------------------------------------------------------------- the email

/** The services the email channel can send through. */
export const EMAIL_PROVIDER_KINDS = ['brevo'] as const;
export type EmailProviderKind = (typeof EMAIL_PROVIDER_KINDS)[number];

/** What a view calls each email service. */
export const EMAIL_PROVIDER_NAMES: Readonly<Record<EmailProviderKind, string>> = { brevo: 'Brevo' };

/** The most addresses a notice is mailed to. */
export const EMAIL_RECIPIENTS_MAX = 20;

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

/** Why a list of recipients is refused, a sentence each, or an empty list when it can be saved. */
export function emailRecipientsProblems(recipients: readonly string[]): string[] {
  const problems: string[] = [];
  if (recipients.length === 0) problems.push('Enter one recipient or more.');
  if (recipients.length > EMAIL_RECIPIENTS_MAX) {
    problems.push(`The list holds at most ${EMAIL_RECIPIENTS_MAX} addresses.`);
  }
  const seen = new Set<string>();
  for (const value of recipients) {
    const problem = emailAddressProblem(value);
    if (problem !== null) problems.push(`${value.trim() || 'An empty line'}: ${problem}`);
    const email = storedEmailAddress(value);
    if (problem === null && seen.has(email)) problems.push(`${email} is on the list twice.`);
    seen.add(email);
  }
  return problems;
}

/** The email channel's settings. Its secret is the service's API key. */
export interface EmailChannelSettings {
  /** The service the mails go through. */
  provider: EmailProviderKind;
  /** The address the mails come from, one the service sends for. Trimmed, in lower case. */
  senderAddress: string;
  /** The name shown beside that address, or empty for none. */
  senderName: string;
  /** Who a notice is mailed to, {@link EMAIL_RECIPIENTS_MAX} at most, each trimmed and in lower case. */
  recipients: string[];
}

// ----------------------------------------------------------------- the chats

/**
 * The Slack channel's settings: none. Its secret is the incoming webhook's URL, and Slack fixes the channel a webhook
 * writes to when the webhook is made.
 */
export type SlackChannelSettings = Record<string, never>;

/** The Telegram channel's settings. Its secret is the bot's token. */
export interface TelegramChannelSettings {
  /**
   * The chat the bot writes to: a chat's numeric id, negative for a group, such as `-1001234567890`, or a public
   * channel's name with its `@`, such as `@channelname`.
   */
  chatId: string;
}

/** A chat's numeric id: a whole number, negative for a group, with no leading zero. */
const TELEGRAM_CHAT_NUMBER_PATTERN = /^-?[1-9][0-9]{0,18}$/;

/** A public channel's or group's name: `@`, a letter, then letters, digits and underscores, 5 to 32 in all. */
const TELEGRAM_CHAT_NAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;

// -------------------------------------------------------------- the settings

/** Each channel's settings, by its kind. */
export interface NotificationChannelSettingsByKind {
  email: EmailChannelSettings;
  slack: SlackChannelSettings;
  telegram: TelegramChannelSettings;
}

export type NotificationChannelSettings = NotificationChannelSettingsByKind[NotificationChannelKind];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emailSettingsProblems(settings: Record<string, unknown>): string[] {
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
  if (!Array.isArray(settings.recipients) || settings.recipients.some((value) => typeof value !== 'string')) {
    problems.push('The recipients are a list of email addresses.');
  } else {
    problems.push(...emailRecipientsProblems(settings.recipients as string[]));
  }
  return problems;
}

function telegramSettingsProblems(settings: Record<string, unknown>): string[] {
  const chatId = typeof settings.chatId === 'string' ? settings.chatId.trim() : '';
  return TELEGRAM_CHAT_NUMBER_PATTERN.test(chatId) || TELEGRAM_CHAT_NAME_PATTERN.test(chatId)
    ? []
    : [
        "The chat id is a whole number, such as -1001234567890 for a group, or a public channel's name, such as @channelname.",
      ];
}

/**
 * Why these cannot be the channel's settings, a sentence each, or an empty list when they can be saved. It takes what
 * a request's body holds, of any shape.
 */
export function channelSettingsProblems(kind: NotificationChannelKind, settings: unknown): string[] {
  if (!isRecord(settings)) return [`The ${NOTIFICATION_CHANNEL_NAMES[kind]} settings are missing.`];
  switch (kind) {
    case 'email':
      return emailSettingsProblems(settings);
    case 'slack':
      return [];
    case 'telegram':
      return telegramSettingsProblems(settings);
  }
}

/**
 * The settings as they are kept, once {@link channelSettingsProblems} found nothing: addresses, the sender's name and
 * the chat id trimmed, addresses in lower case, and nothing a form sent beside them.
 */
export function storedChannelSettings<K extends NotificationChannelKind>(
  kind: K,
  settings: NotificationChannelSettingsByKind[K],
): NotificationChannelSettingsByKind[K];
export function storedChannelSettings(
  kind: NotificationChannelKind,
  settings: NotificationChannelSettings,
): NotificationChannelSettings {
  switch (kind) {
    case 'email': {
      const email = settings as EmailChannelSettings;
      return {
        provider: email.provider,
        senderAddress: storedEmailAddress(email.senderAddress),
        senderName: email.senderName.trim(),
        recipients: email.recipients.map(storedEmailAddress),
      };
    }
    case 'slack':
      return {};
    case 'telegram':
      return { chatId: (settings as TelegramChannelSettings).chatId.trim() };
  }
}
