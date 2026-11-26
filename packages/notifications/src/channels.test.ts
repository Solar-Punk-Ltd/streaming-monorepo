/**
 * The channel to one person's destination: the exact request each service's channel makes, what the cuts at line breaks
 * do to a long notice, and what a channel refuses before it calls anything. A fake fetch stands in for the services.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { BrevoEmailProvider } from './brevo.js';
import {
  NotificationSendError,
  type DestinationChannelConfig,
  type DestinationChannelFactory,
  type NotificationFetch,
} from './channel.js';
import { cutAtLineBreaks, destinationChannelFrom } from './channels.js';
import { TELEGRAM_MESSAGE_MAX_LENGTH, type EmailServiceSettings, type Notice } from './rules.js';

const BREVO_KEY = `xkeysib-${'a'.repeat(64)}-${'B'.repeat(16)}`;
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;

const sender: EmailServiceSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream alerts',
};

const toAda: Extract<DestinationChannelConfig, { kind: 'email' }> = {
  kind: 'email',
  settings: sender,
  secret: BREVO_KEY,
  address: 'ada@example.org',
};
const toChat: Extract<DestinationChannelConfig, { kind: 'telegram' }> = {
  kind: 'telegram',
  settings: {},
  secret: TELEGRAM_TOKEN,
  address: '-1001234567890',
};
const configs: DestinationChannelConfig[] = [toAda, toChat];

const notice: Notice = {
  title: 'Stamp top-ups coming up',
  text: 'Two stamps are due for a top-up.\nThe brand wallet sends tomorrow.',
};

/** A notice of `count` lines of 50 characters each, under a short title. */
function longNotice(count: number): Notice {
  const lines = Array.from(
    { length: count },
    (_unused, index) => `Line ${String(index).padStart(3, '0')}: ${'y'.repeat(40)}`,
  );
  return { title: 'Many stamps', text: lines.join('\n') };
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that keeps what each call sent, and answers the calls with `answers` in turn, the last again once they run out. */
function fakeFetch(...answers: (() => Response)[]): { fetch: NotificationFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: NotificationFetch = (input, init = {}) => {
    sent.push({
      method: String(init.method),
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const answer = answers.at(Math.min(sent.length, answers.length) - 1);
    return Promise.resolve(answer === undefined ? new Response('ok', { status: 200 }) : answer());
  };
  return { fetch, sent };
}

/** The texts the calls sent, in order. */
function textsOf(sent: Sent[]): string[] {
  return sent.map(({ body }) => String(body.text));
}

/** The error a send that has to fail rejects with. */
async function failure(sending: Promise<unknown>): Promise<NotificationSendError> {
  try {
    await sending;
  } catch (error) {
    assert.ok(error instanceof NotificationSendError, String(error));
    return error;
  }
  assert.fail('The service took it.');
}

describe('the email channel', () => {
  it("mails one person's notice to their address alone, from the service's sender, with the API key in a header", async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{"messageId":"<1@example.org>"}', { status: 201 }));
    await destinationChannelFrom(toAda, { fetch }).send(notice);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { accept: 'application/json', 'api-key': BREVO_KEY, 'content-type': 'application/json' },
        body: {
          sender: { email: 'alerts@example.org', name: 'Stream alerts' },
          to: [{ email: 'ada@example.org' }],
          subject: 'Stamp top-ups coming up',
          textContent: 'Two stamps are due for a top-up.\nThe brand wallet sends tomorrow.',
        },
      },
    ]);
  });

  it("sends two people's notices as two mails, neither naming the other", async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{}', { status: 201 }));
    await destinationChannelFrom(toAda, { fetch }).send(notice);
    await destinationChannelFrom({ ...toAda, address: 'grace@example.org' }, { fetch }).send(notice);
    assert.deepEqual(
      sent.map(({ body }) => body.to),
      [[{ email: 'ada@example.org' }], [{ email: 'grace@example.org' }]],
    );
  });

  it("names no sender's name when the service has none", async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{}', { status: 201 }));
    await destinationChannelFrom({ ...toAda, settings: { ...sender, senderName: '' } }, { fetch }).send(notice);
    assert.deepEqual(sent[0].body.sender, { email: 'alerts@example.org' });
  });

  it('says why Brevo refused the mail, without the key', async () => {
    const answer = JSON.stringify({ code: 'unauthorized', message: `Key ${BREVO_KEY} not found` });
    const { fetch } = fakeFetch(() => new Response(answer, { status: 401 }));
    const error = await failure(destinationChannelFrom(toAda, { fetch }).send(notice));
    assert.equal(error.message, 'Brevo answered with status 401: Key [hidden] not found.');
    assert.equal(error.status, 401);
  });

  it('calls nothing with a key it would not have saved', async () => {
    const { fetch, sent } = fakeFetch();
    const error = await failure(destinationChannelFrom({ ...toAda, secret: 'too short' }, { fetch }).send(notice));
    assert.equal(error.message, "The email service's API key is not one it gives out, so Brevo was not called.");
    assert.equal(sent.length, 0);
  });

  it('sends through the provider its settings name, and through none it does not have', async () => {
    assert.equal(new BrevoEmailProvider(BREVO_KEY).kind, 'brevo');
    const { fetch, sent } = fakeFetch();
    const other = { ...sender, provider: 'other' } as unknown as EmailServiceSettings;
    const error = await failure(destinationChannelFrom({ ...toAda, settings: other }, { fetch }).send(notice));
    assert.equal(error.message, "The email channel's service is not one a notice can go out through.");
    assert.equal(sent.length, 0);
  });
});

describe('the Telegram channel', () => {
  it('sends the title, an empty line and the text as they are, to the chat, with no parse mode and no link preview', async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{"ok":true,"result":{}}', { status: 200 }));
    await destinationChannelFrom(toChat, { fetch }).send({
      title: 'Fees & <stamps>',
      text: 'See https://example.org & <b>',
    });
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: {
          chat_id: '-1001234567890',
          text: 'Fees & <stamps>\n\nSee https://example.org & <b>',
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  it(`sends a notice over ${TELEGRAM_MESSAGE_MAX_LENGTH} characters as several, cut at line breaks, in order`, async () => {
    const long = longNotice(200);
    const { fetch, sent } = fakeFetch();
    await destinationChannelFrom(toChat, { fetch }).send(long);
    const texts = textsOf(sent);
    assert.equal(texts.length, 3);
    for (const text of texts) assert.ok(text.length <= TELEGRAM_MESSAGE_MAX_LENGTH, `${text.length} characters`);
    assert.ok(texts[0].startsWith('Many stamps\n\nLine 000: '));
    assert.equal(texts.join('\n'), `${long.title}\n\n${long.text}`);
    for (const text of texts.slice(1)) assert.match(text, /^Line \d{3}: y{40}(\nLine \d{3}: y{40})*$/);
  });

  it('takes a notice only once every part is taken, and stops at the first part that fails', async () => {
    const tooMany = '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 5"}';
    const { fetch, sent } = fakeFetch(
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response(tooMany, { status: 429 }),
    );
    const error = await failure(destinationChannelFrom(toChat, { fetch }).send(longNotice(200)));
    assert.equal(sent.length, 2);
    assert.equal(
      error.message,
      "1 of the notice's 3 messages went out, then: Telegram answered with status 429: Too Many Requests: retry after 5.",
    );
    assert.equal(error.status, 429);
  });

  it('says why Telegram refused, without the token', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(`{"ok":false,"error_code":401,"description":"Unauthorized bot ${TELEGRAM_TOKEN}"}`, {
          status: 401,
        }),
    );
    const error = await failure(destinationChannelFrom(toChat, { fetch }).send(notice));
    assert.equal(error.message, 'Telegram answered with status 401: Unauthorized bot [hidden].');
    assert.equal(error.status, 401);
  });

  it('calls nothing with a token BotFather would not give out', async () => {
    const { fetch, sent } = fakeFetch();
    for (const secret of [`${TELEGRAM_TOKEN}/../getMe`, `${TELEGRAM_TOKEN}?chat_id=1`, 'not a token']) {
      const error = await failure(destinationChannelFrom({ ...toChat, secret }, { fetch }).send(notice));
      assert.equal(error.message, "The bot's token is not one BotFather gives out, so Telegram was not called.");
    }
    assert.equal(sent.length, 0);
  });
});

describe('a text cut at line breaks', () => {
  it('is one part, as it is, when it fits', () => {
    assert.deepEqual(cutAtLineBreaks('one\n\ntwo\n', 9), ['one\n\ntwo\n']);
  });

  it('holds as many whole lines in a part as fit, and blank lines only inside one', () => {
    assert.deepEqual(cutAtLineBreaks('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
    assert.deepEqual(cutAtLineBreaks('aaaa\n\n\nbbbb', 6), ['aaaa', 'bbbb']);
    assert.deepEqual(cutAtLineBreaks('aa\n\nbb\ncccccc', 6), ['aa\n\nbb', 'cccccc']);
  });

  it('cuts a line too long for a part at its last space that fits, or where it has to be', () => {
    assert.deepEqual(cutAtLineBreaks('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
    assert.deepEqual(cutAtLineBreaks('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });

  it('never cuts inside a character', () => {
    assert.deepEqual(cutAtLineBreaks('😀'.repeat(5), 3), ['😀', '😀', '😀', '😀', '😀']);
  });
});

describe('destinationChannelFrom', () => {
  it('is the DestinationChannelFactory, and builds a channel for each service', () => {
    const factory: DestinationChannelFactory = destinationChannelFrom;
    assert.deepEqual(
      configs.map((config) => factory(config).kind),
      ['email', 'telegram'],
    );
  });

  it("keeps every service's secret out of sight", () => {
    for (const config of configs) {
      const channel = destinationChannelFrom(config);
      assert.equal(inspect(channel, { showHidden: true, depth: 10 }).includes(config.secret), false, config.kind);
      assert.equal(JSON.stringify(channel).includes(config.secret), false, config.kind);
    }
  });

  it('refuses a notice that cannot go out, and calls nothing', async () => {
    const { fetch, sent } = fakeFetch();
    for (const config of configs) {
      const error = await failure(destinationChannelFrom(config, { fetch }).send({ title: ' ', text: 'Two stamps.' }));
      assert.equal(error.message, 'A notice has a title.', config.kind);
    }
    assert.equal(sent.length, 0);
  });
});
