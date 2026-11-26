/**
 * Find chat id: the chats that wrote to a Telegram bot lately, read from the Bot API's `getUpdates` with the bot's
 * token, so a person picks the chat the notices go to rather than reading the Bot API's answer themselves.
 * https://core.telegram.org/bots/api#getupdates
 *
 * - The call is `readService`'s: a `POST` to Telegram's fixed host, no redirect followed, an end after
 *   `NOTIFICATION_CALL_TIMEOUT_MS`, at most `NOTIFICATION_ANSWER_MAX_BYTES` of the answer read.
 * - It sends no `offset`, so Telegram marks no update as read and forgets none, and no `allowed_updates`, which
 *   Telegram would keep for the bot.
 * - Telegram keeps a bot's updates for a day, so the chats are those that wrote to the bot, added it or posted in its
 *   channel within the last day: the oldest {@link TELEGRAM_CHATS_UPDATES_LIMIT} of those updates.
 * - A bot whose updates go to a webhook has none to read here, and Telegram says so in its refusal.
 */

import { readService, type NotificationCallOptions } from './call.js';
import { NotificationSendError } from './channel.js';
import {
  channelSecretProblem,
  isTelegramChatKind,
  storedChannelSecret,
  TELEGRAM_API_HOST,
  TELEGRAM_CHAT_NAME_MAX_LENGTH,
  type TelegramChat,
} from './rules.js';

/** The most updates one lookup reads, which keeps the answer well under the most that is read of it. */
export const TELEGRAM_CHATS_UPDATES_LIMIT = 20;

/** The parts of an update that name a chat. */
const CHAT_PARTS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
] as const;

const UNREADABLE = "Telegram's answer could not be read as the bot's updates.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A text Telegram gave, as one line: every run of characters that are not printable as one space. */
function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\p{C}\p{Z}]+/gu, ' ').trim() : '';
}

/** The chat's name as Find chat id shows it: a person's name or a title, then its `@username` in brackets. */
function nameOf(chat: Record<string, unknown>): string {
  const own =
    chat.type === 'private'
      ? [oneLine(chat.first_name), oneLine(chat.last_name)].filter((part) => part !== '').join(' ')
      : oneLine(chat.title);
  const username = oneLine(chat.username);
  const name = username === '' ? own : own === '' ? `@${username}` : `${own} (@${username})`;
  const characters = Array.from(name);
  if (characters.length <= TELEGRAM_CHAT_NAME_MAX_LENGTH) return name;
  return `${characters
    .slice(0, TELEGRAM_CHAT_NAME_MAX_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** The chat a part of an update names, or null for one that is not a chat as Telegram describes one. */
function chatOf(value: unknown): TelegramChat | null {
  if (!isRecord(value)) return null;
  const { id, type } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id === 0 || !isTelegramChatKind(type)) return null;
  return { id: String(id), kind: type, name: nameOf(value) };
}

/** The chats one update names: its message's, its post's or its member change's, and a pressed button's message's. */
function chatsIn(update: unknown): TelegramChat[] {
  if (!isRecord(update)) return [];
  const named: unknown[] = CHAT_PARTS.map((part) => {
    const value = update[part];
    return isRecord(value) ? value.chat : undefined;
  });
  const pressed = update.callback_query;
  if (isRecord(pressed) && isRecord(pressed.message)) named.push(pressed.message.chat);
  return named.map(chatOf).filter((chat): chat is TelegramChat => chat !== null);
}

/**
 * The chats a `getUpdates` answer names, the latest first, each once. Rejects with a {@link NotificationSendError} for
 * an answer that is not the bot's updates.
 */
export function chatsOfUpdates(answer: string): TelegramChat[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new NotificationSendError(UNREADABLE);
  }
  if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.result)) {
    throw new NotificationSendError(UNREADABLE);
  }
  // Telegram lists the updates oldest first.
  const chats = new Map<string, TelegramChat>();
  for (const update of [...parsed.result].reverse()) {
    for (const chat of chatsIn(update)) {
      if (!chats.has(chat.id)) chats.set(chat.id, chat);
    }
  }
  return [...chats.values()];
}

/**
 * The chats that wrote to the bot whose token this is within the last day, the latest first, each once. Rejects with
 * a {@link NotificationSendError} whose sentence never holds the token: for a token BotFather would not give out,
 * without calling Telegram; for Telegram's refusal, such as a wrong token or a bot whose updates go to a webhook; and
 * for an answer that is not the bot's updates.
 */
export async function findTelegramChats(token: string, options: NotificationCallOptions = {}): Promise<TelegramChat[]> {
  const bare = storedChannelSecret(token);
  if (channelSecretProblem('telegram', bare) !== null) {
    throw new NotificationSendError("The bot's token is not one BotFather gives out, so Telegram was not called.");
  }
  const answer = await readService(
    {
      service: 'Telegram',
      host: TELEGRAM_API_HOST,
      path: `/bot${bare}/getUpdates`,
      body: { limit: TELEGRAM_CHATS_UPDATES_LIMIT },
      // The token is the secret, and the part after its colon is the bot's key.
      secrets: [bare, bare.slice(bare.indexOf(':') + 1)],
    },
    options.fetch,
  );
  return chatsOfUpdates(answer);
}
