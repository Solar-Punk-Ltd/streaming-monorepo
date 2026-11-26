/**
 * Find chat id's lookup: `getUpdates` with the bot's token, and the chats its updates name. Every token and chat here
 * is made up for the test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationSendError, type NotificationFetch } from './channel.js';
import { TELEGRAM_CHAT_NAME_MAX_LENGTH } from './rules.js';
import { findTelegramChats, TELEGRAM_CHATS_UPDATES_LIMIT } from './telegram.js';

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
