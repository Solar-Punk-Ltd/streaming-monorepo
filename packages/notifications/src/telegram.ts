/**
 * The reads of a Telegram bot with its token, each a `readService` call: a `POST` to Telegram's fixed host, no redirect
 * followed, an end after `NOTIFICATION_CALL_TIMEOUT_MS`, at most `NOTIFICATION_ANSWER_MAX_BYTES` of the answer read,
 * and a failure's sentence that never holds the token. None sends `allowed_updates`, which Telegram would keep for the
 * bot.
 *
 * Find my chat reads two: {@link lookUpTelegramBot}, the bot's name from `getMe`, and {@link findTelegramChatByCode},
 * the one chat that sent a person's code, from `getUpdates` with an offset of -{@link TELEGRAM_CHATS_UPDATES_LIMIT}.
 *
 * Find chat id lists the chats that wrote to the bot lately with {@link findTelegramChats}, read from `getUpdates`, so a
 * person picks the chat the notices go to rather than reading the Bot API's answer themselves.
 * https://core.telegram.org/bots/api#getupdates
 *
 * - It sends no `offset`, so Telegram marks no update as read and forgets none.
 * - Telegram keeps a bot's updates for a day, so the chats are those that wrote to the bot, added it or posted in its
 *   channel within the last day: the oldest {@link TELEGRAM_CHATS_UPDATES_LIMIT} of those updates.
 * - A bot whose updates go to a webhook has none to read here, and Telegram says so in its refusal.
 */

import { readService, type NotificationCallOptions } from './call.js';
import { NotificationSendError } from './channel.js';
import {
  channelSecretProblem,
  isTelegramBotUsername,
  isTelegramChatCode,
  isTelegramChatKind,
  storedChannelSecret,
  TELEGRAM_API_HOST,
  TELEGRAM_CHAT_NAME_MAX_LENGTH,
  telegramTextSendsCode,
  type TelegramBot,
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
  return shortened(username === '' ? own : own === '' ? `@${username}` : `${own} (@${username})`);
}

/** A name of at most `TELEGRAM_CHAT_NAME_MAX_LENGTH` characters, the last of a longer one an ellipsis. */
function shortened(name: string): string {
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

/** The token as it is called with, trimmed. Throws, calling nothing, for one BotFather would not give out. */
function checkedToken(token: string): string {
  const bare = storedChannelSecret(token);
  if (channelSecretProblem('telegram', bare) !== null) {
    throw new NotificationSendError("The bot's token is not one BotFather gives out, so Telegram was not called.");
  }
  return bare;
}

/** Reads one Bot API method's answer with the bot's token. */
function readBotApi(token: string, method: string, body: unknown, options: NotificationCallOptions): Promise<string> {
  return readService(
    {
      service: 'Telegram',
      host: TELEGRAM_API_HOST,
      path: `/bot${token}/${method}`,
      body,
      // The token is the secret, and the part after its colon is the bot's key.
      secrets: [token, token.slice(token.indexOf(':') + 1)],
    },
    options.fetch,
  );
}

/** The `result` of a Bot API answer that is `ok`. Throws the error with this sentence for any other answer. */
function resultOf(answer: string, unreadable: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new NotificationSendError(unreadable);
  }
  if (!isRecord(parsed) || parsed.ok !== true) throw new NotificationSendError(unreadable);
  return parsed.result;
}

/**
 * The chats that wrote to the bot whose token this is within the last day, the latest first, each once. Rejects with
 * a {@link NotificationSendError} whose sentence never holds the token: for a token BotFather would not give out,
 * without calling Telegram; for Telegram's refusal, such as a wrong token or a bot whose updates go to a webhook; and
 * for an answer that is not the bot's updates.
 */
export async function findTelegramChats(token: string, options: NotificationCallOptions = {}): Promise<TelegramChat[]> {
  const bare = checkedToken(token);
  return chatsOfUpdates(await readBotApi(bare, 'getUpdates', { limit: TELEGRAM_CHATS_UPDATES_LIMIT }, options));
}

// ------------------------------------------------------------- the bot itself

const NOT_A_BOT = "Telegram's answer could not be read as a bot.";

/**
 * The bot a token is of, from the Bot API's `getMe`: the `TelegramBotLookup` Find my chat names the bot with, and links
 * to it by its username. https://core.telegram.org/bots/api#getme
 *
 * Rejects with a {@link NotificationSendError} whose sentence never holds the token: for a token BotFather would not
 * give out, without calling Telegram; for Telegram's refusal; and for an answer that is not a bot's with a username a
 * `t.me` link can name.
 */
export async function lookUpTelegramBot(token: string, options: NotificationCallOptions = {}): Promise<TelegramBot> {
  const bare = checkedToken(token);
  const bot = resultOf(await readBotApi(bare, 'getMe', {}, options), NOT_A_BOT);
  if (!isRecord(bot) || bot.is_bot !== true || !isTelegramBotUsername(bot.username)) {
    throw new NotificationSendError(NOT_A_BOT);
  }
  const shown = oneLine(bot.first_name);
  return { username: bot.username, name: shortened(shown === '' ? bot.username : shown) };
}

// ------------------------------------------------- the chat that sent a code

/** The parts of an update that are a message with a text: in a person's chat, a group or a channel. */
const MESSAGE_PARTS = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const;

/**
 * The chat of the latest message in a `getUpdates` answer whose text sends the code, or null when none does. Rejects
 * with a {@link NotificationSendError} for an answer that is not the bot's updates.
 */
export function chatThatSentCode(answer: string, code: string): TelegramChat | null {
  const result = resultOf(answer, UNREADABLE);
  if (!Array.isArray(result)) throw new NotificationSendError(UNREADABLE);
  // Telegram lists the updates oldest first.
  for (const update of [...result].reverse()) {
    if (!isRecord(update)) continue;
    for (const part of MESSAGE_PARTS) {
      const message = update[part];
      if (!isRecord(message) || typeof message.text !== 'string') continue;
      if (!telegramTextSendsCode(message.text, code)) continue;
      const chat = chatOf(message.chat);
      if (chat !== null) return chat;
    }
  }
  return null;
}

/**
 * Finds the chat that sent a code to the bot whose token this is: the `TelegramChatLookup` of Find my chat. It reads
 * the Bot API's `getUpdates` with an offset of -{@link TELEGRAM_CHATS_UPDATES_LIMIT}, which answers the bot's latest
 * updates and on which Telegram forgets the ones before those, and answers the chat of the latest message whose text
 * sends the code (`telegramTextSendsCode`), or null when none does. It answers that one chat, never a list.
 *
 * Rejects with a {@link NotificationSendError} whose sentence never holds the token, as {@link lookUpTelegramBot} does,
 * for an answer that is not the bot's updates, and, without calling Telegram, for a code `isTelegramChatCode` refuses.
 */
export async function findTelegramChatByCode(
  token: string,
  code: string,
  options: NotificationCallOptions = {},
): Promise<TelegramChat | null> {
  const bare = checkedToken(token);
  if (!isTelegramChatCode(code)) {
    throw new NotificationSendError('The code is not one Find my chat gives out, so Telegram was not called.');
  }
  const answer = await readBotApi(bare, 'getUpdates', { offset: -TELEGRAM_CHATS_UPDATES_LIMIT }, options);
  return chatThatSentCode(answer, code);
}
