/**
 * Find chat id's lookup: `getUpdates` with the bot's token, and the chats its updates name. Every token and chat here
 * is made up for the test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NotificationSendError,
  type NotificationFetch,
  type TelegramBotLookup,
  type TelegramChatLookup,
} from './channel.js';
import { TELEGRAM_CHAT_NAME_MAX_LENGTH, type TelegramBot, type TelegramChat } from './rules.js';
import {
  findTelegramChatByCode,
  findTelegramChats,
  lookUpTelegramBot,
  TELEGRAM_CHATS_UPDATES_LIMIT,
} from './telegram.js';

const TOKEN = `1234567890:${'A'.repeat(35)}`;

interface Sent {
  method: string;
  url: string;
  redirect: string;
  body: Record<string, unknown>;
}

/** A fetch that keeps what each call sent, and answers every call with `answer`. */
function fakeFetch(answer: () => Response): { fetch: NotificationFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: NotificationFetch = (input, init = {}) => {
    sent.push({
      method: String(init.method),
      url: String(input),
      redirect: String(init.redirect),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

/** Telegram's answer holding these updates, each given an update id in turn. */
function updates(...result: Record<string, unknown>[]): () => Response {
  const body = JSON.stringify({ ok: true, result: result.map((update, at) => ({ update_id: 900 + at, ...update })) });
  return () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

const ADA = { id: 111111111, type: 'private', first_name: 'Ada', last_name: 'Lovelace', username: 'ada' };
const OPS = { id: -1001234567890, type: 'supergroup', title: 'Stream ops' };
const ALERTS = { id: -1009876543210, type: 'channel', title: 'Alerts', username: 'streamalerts' };
const OTHER = { id: -4123456789, type: 'group', title: 'Other' };

async function failure(finding: Promise<unknown>): Promise<NotificationSendError> {
  try {
    await finding;
  } catch (error) {
    assert.ok(error instanceof NotificationSendError, String(error));
    return error;
  }
  assert.fail('The lookup found chats.');
}

describe("Find chat id's lookup", () => {
  it(`asks getUpdates for at most ${TELEGRAM_CHATS_UPDATES_LIMIT} updates, with no offset, following no redirect`, async () => {
    const { fetch, sent } = fakeFetch(updates());
    assert.deepEqual(await findTelegramChats(` ${TOKEN} `, { fetch }), []);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: `https://api.telegram.org/bot${TOKEN}/getUpdates`,
        redirect: 'manual',
        body: { limit: TELEGRAM_CHATS_UPDATES_LIMIT },
      },
    ]);
  });

  it('lists the chats the updates name, the latest first and each once, with their names', async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { message_id: 1, chat: ADA, text: '/start' } },
        { my_chat_member: { chat: OPS, date: 1 } },
        { message: { message_id: 2, chat: ADA, text: 'hi' } },
        { channel_post: { message_id: 3, chat: ALERTS, text: 'post' } },
        { callback_query: { id: 'q', message: { message_id: 4, chat: OTHER } } },
      ),
    );
    assert.deepEqual(await findTelegramChats(TOKEN, { fetch }), [
      { id: '-4123456789', kind: 'group', name: 'Other' },
      { id: '-1009876543210', kind: 'channel', name: 'Alerts (@streamalerts)' },
      { id: '111111111', kind: 'private', name: 'Ada Lovelace (@ada)' },
      { id: '-1001234567890', kind: 'supergroup', name: 'Stream ops' },
    ]);
  });

  it('names a chat by its username alone, or by nothing, when Telegram gave no name or title', async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { chat: { id: 222222222, type: 'private', username: 'nameless' } } },
        { message: { chat: { id: 333333333, type: 'private' } } },
      ),
    );
    assert.deepEqual(await findTelegramChats(TOKEN, { fetch }), [
      { id: '333333333', kind: 'private', name: '' },
      { id: '222222222', kind: 'private', name: '@nameless' },
    ]);
  });

  it(`shows a name as one line of at most ${TELEGRAM_CHAT_NAME_MAX_LENGTH} characters`, async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { chat: { id: -100111, type: 'supergroup', title: 'Line one\nline\ttwo​' } } },
        { message: { chat: { id: -100222, type: 'supergroup', title: 'x'.repeat(400) } } },
      ),
    );
    const [long, multiline] = await findTelegramChats(TOKEN, { fetch });
    assert.equal(multiline?.name, 'Line one line two');
    assert.equal(Array.from(long?.name ?? '').length, TELEGRAM_CHAT_NAME_MAX_LENGTH);
    assert.ok(long?.name.endsWith('…'));
  });

  it('passes over what is not a chat: an id that is not a whole number, a kind Telegram has not, a part with none', async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { chat: { id: '111111111', type: 'private' } } },
        { message: { chat: { id: 1.5, type: 'private' } } },
        { message: { chat: { id: 2 ** 60, type: 'private' } } },
        { message: { chat: { id: 0, type: 'private' } } },
        { message: { chat: { id: 444444444, type: 'secret' } } },
        { message: { text: 'no chat' } },
        { poll: { id: 'p', question: 'Which?' } },
        { message: { chat: ADA } },
      ),
    );
    assert.deepEqual(await findTelegramChats(TOKEN, { fetch }), [
      { id: '111111111', kind: 'private', name: 'Ada Lovelace (@ada)' },
    ]);
  });

  it('says why Telegram refused, without the token', async () => {
    for (const [status, description, expected] of [
      [401, 'Unauthorized', 'Telegram answered with status 401: Unauthorized.'],
      [
        409,
        "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
        "Telegram answered with status 409: Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first.",
      ],
      [404, `Not Found: bot${TOKEN}`, 'Telegram answered with status 404: Not Found: bot[hidden].'],
    ] as const) {
      const { fetch } = fakeFetch(
        () => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status }),
      );
      const error = await failure(findTelegramChats(TOKEN, { fetch }));
      assert.equal(error.message, expected);
      assert.equal(error.status, status);
    }
  });

  it("refuses an answer that is not the bot's updates", async () => {
    for (const body of ['<html>busy</html>', '{"ok":false}', '{"ok":true,"result":{}}', '[]']) {
      const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
      const error = await failure(findTelegramChats(TOKEN, { fetch }));
      assert.equal(error.message, "Telegram's answer could not be read as the bot's updates.");
    }
  });

  it('refuses an answer longer than the most that is read of one, rather than reading part of it', async () => {
    const message = { message_id: 1, chat: ADA, text: 'y'.repeat(4000) };
    const { fetch } = fakeFetch(updates(...Array.from({ length: 5 }, () => ({ message }))));
    const error = await failure(findTelegramChats(TOKEN, { fetch }));
    assert.equal(error.message, "Telegram's answer could not be read whole: it broke off, or it is longer than 16 KB.");
  });

  it('calls nothing with a token BotFather would not give out', async () => {
    const { fetch, sent } = fakeFetch(updates());
    for (const token of [`${TOKEN}/../getMe`, `${TOKEN}?offset=1`, 'not a token', '']) {
      const error = await failure(findTelegramChats(token, { fetch }));
      assert.equal(error.message, "The bot's token is not one BotFather gives out, so Telegram was not called.");
    }
    assert.equal(sent.length, 0);
  });
});

describe("Find my chat's bot", () => {
  /** Telegram's answer to getMe for this bot. */
  function me(result: Record<string, unknown>): () => Response {
    const body = JSON.stringify({ ok: true, result });
    return () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const BOT = { id: 1234567890, is_bot: true, first_name: 'Stream alerts', username: 'stream_alerts_bot' };

  it('is the TelegramBotLookup, and asks getMe with nothing more, following no redirect', async () => {
    const { fetch, sent } = fakeFetch(me(BOT));
    const lookup: TelegramBotLookup = (token) => lookUpTelegramBot(token, { fetch });
    const bot: TelegramBot = await lookup(` ${TOKEN} `);
    assert.deepEqual(bot, { username: 'stream_alerts_bot', name: 'Stream alerts' });
    assert.deepEqual(sent, [
      { method: 'POST', url: `https://api.telegram.org/bot${TOKEN}/getMe`, redirect: 'manual', body: {} },
    ]);
  });

  it(`names the bot by its username when it shows no name, in one line of at most ${TELEGRAM_CHAT_NAME_MAX_LENGTH} characters`, async () => {
    const bare = fakeFetch(me({ ...BOT, first_name: ' \n ' }));
    assert.deepEqual(await lookUpTelegramBot(TOKEN, { fetch: bare.fetch }), {
      username: 'stream_alerts_bot',
      name: 'stream_alerts_bot',
    });
    const long = fakeFetch(me({ ...BOT, first_name: `Stream\nalerts ${'z'.repeat(300)}` }));
    const { name } = await lookUpTelegramBot(TOKEN, { fetch: long.fetch });
    assert.equal(Array.from(name).length, TELEGRAM_CHAT_NAME_MAX_LENGTH);
    assert.ok(name.startsWith('Stream alerts zz'));
    assert.ok(name.endsWith('…'));
  });

  it("refuses an answer that is not a bot's with a username a link can name", async () => {
    const answers = [
      me({ ...BOT, is_bot: false }),
      me({ ...BOT, username: 'no' }),
      me({ ...BOT, username: 'stream alerts' }),
      () => new Response('{"ok":false}', { status: 200 }),
      () => new Response('<html>busy</html>', { status: 200 }),
    ];
    for (const answer of answers) {
      const { fetch } = fakeFetch(answer);
      const error = await failure(lookUpTelegramBot(TOKEN, { fetch }));
      assert.equal(error.message, "Telegram's answer could not be read as a bot.");
    }
  });

  it('says why Telegram refused, without the token', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error_code: 404, description: `Not Found: bot${TOKEN}` }), {
          status: 404,
        }),
    );
    const error = await failure(lookUpTelegramBot(TOKEN, { fetch }));
    assert.equal(error.message, 'Telegram answered with status 404: Not Found: bot[hidden].');
    assert.equal(error.status, 404);
  });

  it('calls nothing with a token BotFather would not give out', async () => {
    const { fetch, sent } = fakeFetch(me(BOT));
    for (const token of [`${TOKEN}/../getUpdates`, 'not a token', '']) {
      const error = await failure(lookUpTelegramBot(token, { fetch }));
      assert.equal(error.message, "The bot's token is not one BotFather gives out, so Telegram was not called.");
    }
    assert.equal(sent.length, 0);
  });
});

describe('Find my chat: the chat that sent the code', () => {
  const CODE = 'ABCDE23456';
  const ME = { id: 222222222, type: 'private', first_name: 'Grace', username: 'grace' };

  it(`is the TelegramChatLookup, and asks getUpdates with an offset of -${TELEGRAM_CHATS_UPDATES_LIMIT}, following no redirect`, async () => {
    const { fetch, sent } = fakeFetch(updates());
    const lookup: TelegramChatLookup = (token, code) => findTelegramChatByCode(token, code, { fetch });
    assert.equal(await lookup(` ${TOKEN} `, CODE), null);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: `https://api.telegram.org/bot${TOKEN}/getUpdates`,
        redirect: 'manual',
        body: { offset: -TELEGRAM_CHATS_UPDATES_LIMIT },
      },
    ]);
  });

  it('answers the one chat whose message sends the code, and none of the others', async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { message_id: 1, chat: ADA, text: '/start' } },
        { message: { message_id: 2, chat: ME, text: `/start ${CODE}` } },
        { message: { message_id: 3, chat: OPS, text: 'hello' } },
        { my_chat_member: { chat: OTHER } },
      ),
    );
    const chat: TelegramChat | null = await findTelegramChatByCode(TOKEN, CODE, { fetch });
    assert.deepEqual(chat, { id: '222222222', kind: 'private', name: 'Grace (@grace)' });
  });

  it("reads the code sent in a group, in a channel, typed alone or edited, and answers the latest chat's", async () => {
    for (const [update, expected] of [
      [{ message: { chat: OPS, text: `/start@stream_alerts_bot ${CODE}` } }, '-1001234567890'],
      [{ channel_post: { chat: ALERTS, text: CODE.toLowerCase() } }, '-1009876543210'],
      [{ edited_message: { chat: ADA, text: ` ${CODE} ` } }, '111111111'],
    ] as const) {
      const { fetch } = fakeFetch(updates({ message: { chat: OTHER, text: CODE } }, update));
      assert.equal((await findTelegramChatByCode(TOKEN, CODE, { fetch }))?.id, expected);
    }
  });

  it('answers null when no message sends the code: another code, the code in a sentence, no text, no chat', async () => {
    const { fetch } = fakeFetch(
      updates(
        { message: { chat: ME, text: 'ZZZZZ23456' } },
        { message: { chat: ME, text: `my code is ${CODE}` } },
        { message: { chat: ME, caption: CODE } },
        { message: { chat: { id: 'x', type: 'private' }, text: CODE } },
      ),
    );
    assert.equal(await findTelegramChatByCode(TOKEN, CODE, { fetch }), null);
  });

  it("refuses an answer that is not the bot's updates", async () => {
    for (const body of ['<html>busy</html>', '{"ok":false}', '{"ok":true,"result":{}}', '[]']) {
      const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
      const error = await failure(findTelegramChatByCode(TOKEN, CODE, { fetch }));
      assert.equal(error.message, "Telegram's answer could not be read as the bot's updates.");
    }
  });

  it('says why Telegram refused, without the token', async () => {
    const description = "Conflict: can't use getUpdates method while webhook is active";
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ ok: false, error_code: 409, description }), { status: 409 }),
    );
    const error = await failure(findTelegramChatByCode(TOKEN, CODE, { fetch }));
    assert.equal(error.message, `Telegram answered with status 409: ${description}.`);
    assert.equal(error.status, 409);
  });

  it('calls nothing with a token BotFather would not give out, or a code Find my chat does not give out', async () => {
    const { fetch, sent } = fakeFetch(updates());
    for (const token of [`${TOKEN}/../getMe`, 'not a token']) {
      const error = await failure(findTelegramChatByCode(token, CODE, { fetch }));
      assert.equal(error.message, "The bot's token is not one BotFather gives out, so Telegram was not called.");
    }
    for (const code of ['abcde23456', 'ABCDE2345', 'ABCDE234561', 'ABCDE2345O', '']) {
      const error = await failure(findTelegramChatByCode(TOKEN, code, { fetch }));
      assert.equal(error.message, 'The code is not one Find my chat gives out, so Telegram was not called.');
    }
    assert.equal(sent.length, 0);
  });
});
