/**
 * The three channels and channelFrom: the exact request each channel makes, what Slack's escaping and the cuts at line
 * breaks do to a notice, and what a channel refuses before it calls anything. A fake fetch stands in for the services.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { BrevoEmailProvider } from './brevo.js';
import {
  NotificationSendError,
  type ChannelConfig,
  type ChannelFactory,
  type DestinationChannelConfig,
  type DestinationChannelFactory,
  type NotificationFetch,
} from './channel.js';
import {
  channelFrom,
  cutAtLineBreaks,
  destinationChannelFrom,
  escapeForSlack,
  SLACK_MESSAGE_MAX_LENGTH,
} from './channels.js';
import {
  TELEGRAM_MESSAGE_MAX_LENGTH,
  type EmailChannelSettings,
  type EmailServiceSettings,
  type Notice,
} from './rules.js';

const BREVO_KEY = `xkeysib-${'a'.repeat(64)}-${'B'.repeat(16)}`;
const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/abcdefABCDEF0123456789xy';
const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;

const email: EmailChannelSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream alerts',
  recipients: ['ops@example.org', 'dev@example.org'],
};

const emailConfig: Extract<ChannelConfig, { kind: 'email' }> = { kind: 'email', settings: email, secret: BREVO_KEY };
const slackConfig: Extract<ChannelConfig, { kind: 'slack' }> = { kind: 'slack', settings: {}, secret: SLACK_URL };
const telegramConfig: Extract<ChannelConfig, { kind: 'telegram' }> = {
  kind: 'telegram',
  settings: { chatId: '-1001234567890' },
  secret: TELEGRAM_TOKEN,
};
const configs: ChannelConfig[] = [emailConfig, slackConfig, telegramConfig];

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
  it('posts the mail to Brevo with the API key in a header: the title as the subject, the text as the body', async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{"messageId":"<1@example.org>"}', { status: 201 }));
    await channelFrom(emailConfig, { fetch }).send(notice);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { accept: 'application/json', 'api-key': BREVO_KEY, 'content-type': 'application/json' },
        body: {
          sender: { email: 'alerts@example.org', name: 'Stream alerts' },
          to: [{ email: 'ops@example.org' }, { email: 'dev@example.org' }],
          subject: 'Stamp top-ups coming up',
          textContent: 'Two stamps are due for a top-up.\nThe brand wallet sends tomorrow.',
        },
      },
    ]);
  });

  it("names no sender's name when the settings have none", async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{}', { status: 201 }));
    await channelFrom({ ...emailConfig, settings: { ...email, senderName: '' } }, { fetch }).send(notice);
    assert.deepEqual(sent[0].body.sender, { email: 'alerts@example.org' });
  });

  it('says why Brevo refused the mail, without the key', async () => {
    const answer = JSON.stringify({ code: 'unauthorized', message: `Key ${BREVO_KEY} not found` });
    const { fetch } = fakeFetch(() => new Response(answer, { status: 401 }));
    const error = await failure(channelFrom(emailConfig, { fetch }).send(notice));
    assert.equal(error.message, 'Brevo answered with status 401: Key [hidden] not found.');
    assert.equal(error.status, 401);
  });

  it('calls nothing with a key it would not have saved', async () => {
    const { fetch, sent } = fakeFetch();
    const error = await failure(channelFrom({ ...emailConfig, secret: 'too short' }, { fetch }).send(notice));
    assert.equal(error.message, "The email service's API key is not one it gives out, so Brevo was not called.");
    assert.equal(sent.length, 0);
  });

  it('sends through the provider its settings name, and through none for a service it does not have', async () => {
    assert.equal(new BrevoEmailProvider(BREVO_KEY).kind, 'brevo');
    const { fetch, sent } = fakeFetch();
    const other = { ...email, provider: 'other' } as unknown as EmailChannelSettings;
    const error = await failure(channelFrom({ ...emailConfig, settings: other }, { fetch }).send(notice));
    assert.equal(error.message, "The email channel's service is not one a notice can go out through.");
    assert.equal(sent.length, 0);
  });
});

describe('the Slack channel', () => {
  it('posts the title in bold, an empty line and the text to the webhook', async () => {
    const { fetch, sent } = fakeFetch(() => new Response('ok', { status: 200 }));
    await channelFrom(slackConfig, { fetch }).send(notice);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: SLACK_URL,
        headers: { 'content-type': 'application/json' },
        body: {
          text: '*Stamp top-ups coming up*\n\nTwo stamps are due for a top-up.\nThe brand wallet sends tomorrow.',
        },
      },
    ]);
  });

  it('escapes &, < and > in the title and the text, so nothing mentions anyone or makes a link', async () => {
    const { fetch, sent } = fakeFetch();
    await channelFrom(slackConfig, { fetch }).send({
      title: 'Fees & <stamps>',
      text: '<!channel> <@U0001> <https://example.org|here> & a>b',
    });
    assert.deepEqual(textsOf(sent), [
      '*Fees &amp; &lt;stamps&gt;*\n\n&lt;!channel&gt; &lt;@U0001&gt; &lt;https://example.org|here&gt; &amp; a&gt;b',
    ]);
  });

  it(`cuts a notice over ${SLACK_MESSAGE_MAX_LENGTH} characters, counted escaped, at line breaks`, async () => {
    const lines = Array.from({ length: 70 }, (_unused, index) => `Stamp ${index}: 4 & 5 < 6 > 3, ${'x'.repeat(30)}`);
    const sending = { title: 'Many stamps', text: lines.join('\n') };
    const raw = `*${sending.title}*\n\n${sending.text}`;
    assert.ok(raw.length <= SLACK_MESSAGE_MAX_LENGTH && escapeForSlack(raw).length > SLACK_MESSAGE_MAX_LENGTH);
    const { fetch, sent } = fakeFetch();
    await channelFrom(slackConfig, { fetch }).send(sending);
    const texts = textsOf(sent);
    assert.equal(texts.length, 2);
    for (const text of texts) assert.ok(text.length <= SLACK_MESSAGE_MAX_LENGTH, `${text.length} characters`);
    assert.ok(texts[0].startsWith('*Many stamps*\n\n'));
    assert.equal(texts.join('\n'), escapeForSlack(raw));
  });

  it("says why Slack refused, with no part of the webhook's URL", async () => {
    const { fetch } = fakeFetch(() => new Response('no_service', { status: 404 }));
    const refused = await failure(channelFrom(slackConfig, { fetch }).send(notice));
    assert.equal(refused.message, 'Slack answered with status 404: no_service.');
    assert.equal(refused.status, 404);

    const echoing = fakeFetch(() => new Response(`invalid_token for ${SLACK_URL.slice(8)}`, { status: 403 }));
    const echoed = await failure(channelFrom(slackConfig, { fetch: echoing.fetch }).send(notice));
    assert.equal(
      echoed.message,
      'Slack answered with status 403: invalid_token for hooks.slack.com/services/[hidden]/[hidden]/[hidden].',
    );
  });

  it("calls nothing with a webhook that is not on Slack's host", async () => {
    const { fetch, sent } = fakeFetch();
    for (const secret of [
      'https://example.org/services/T0001/B0001/abcdef',
      'https://hooks.slack.com.example.org/services/T0001/B0001/abcdef',
      'http://hooks.slack.com/services/T0001/B0001/abcdef',
    ]) {
      const error = await failure(channelFrom({ ...slackConfig, secret }, { fetch }).send(notice));
      assert.equal(
        error.message,
        "The webhook's URL is not an incoming webhook on hooks.slack.com, so Slack was not called.",
        secret,
      );
    }
    assert.equal(sent.length, 0);
  });
});

describe('the Telegram channel', () => {
  it('sends the title, an empty line and the text as they are, with no parse mode and no link preview', async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{"ok":true,"result":{}}', { status: 200 }));
    await channelFrom(telegramConfig, { fetch }).send({
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
    await channelFrom(telegramConfig, { fetch }).send(long);
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
    const error = await failure(channelFrom(telegramConfig, { fetch }).send(longNotice(200)));
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
    const error = await failure(channelFrom(telegramConfig, { fetch }).send(notice));
    assert.equal(error.message, 'Telegram answered with status 401: Unauthorized bot [hidden].');
    assert.equal(error.status, 401);
  });

  it('calls nothing with a token BotFather would not give out', async () => {
    const { fetch, sent } = fakeFetch();
    for (const secret of [`${TELEGRAM_TOKEN}/../getMe`, `${TELEGRAM_TOKEN}?chat_id=1`, 'not a token']) {
      const error = await failure(channelFrom({ ...telegramConfig, secret }, { fetch }).send(notice));
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

  it('measures a part as it is sent, and never cuts inside what one character is sent as', () => {
    assert.deepEqual(cutAtLineBreaks('&&&\n&&&', 15, escapeForSlack), ['&amp;&amp;&amp;', '&amp;&amp;&amp;']);
    assert.deepEqual(cutAtLineBreaks('&&&&', 12, escapeForSlack), ['&amp;&amp;', '&amp;&amp;']);
  });
});

describe('the channel to one destination', () => {
  const sender: EmailServiceSettings = { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: 'Alerts' };
  const toAda: DestinationChannelConfig = {
    kind: 'email',
    settings: sender,
    secret: BREVO_KEY,
    address: 'ada@example.org',
  };
  const toChat: DestinationChannelConfig = {
    kind: 'telegram',
    settings: {},
    secret: TELEGRAM_TOKEN,
    address: '111111111',
  };

  it('is the DestinationChannelFactory, and builds a channel for each service', () => {
    const factory: DestinationChannelFactory = destinationChannelFrom;
    assert.deepEqual(
      [toAda, toChat].map((config) => factory(config).kind),
      ['email', 'telegram'],
    );
  });

  it("mails one person's notice to their address alone, from the service's sender", async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{}', { status: 201 }));
    await destinationChannelFrom(toAda, { fetch }).send(notice);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { accept: 'application/json', 'api-key': BREVO_KEY, 'content-type': 'application/json' },
        body: {
          sender: { email: 'alerts@example.org', name: 'Alerts' },
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

  it('sends to the Telegram chat the destination names, as the Telegram channel does', async () => {
    const { fetch, sent } = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    await destinationChannelFrom(toChat, { fetch }).send(notice);
    assert.deepEqual(sent, [
      {
        method: 'POST',
        url: `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: {
          chat_id: '111111111',
          text: `${notice.title}\n\n${notice.text}`,
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  it("keeps the service's secret out of sight, and calls nothing with one it would not have saved", async () => {
    for (const config of [toAda, toChat]) {
      const channel = destinationChannelFrom(config);
      assert.equal(inspect(channel, { showHidden: true, depth: 10 }).includes(config.secret), false, config.kind);
      assert.equal(JSON.stringify(channel).includes(config.secret), false, config.kind);
    }
    const { fetch, sent } = fakeFetch();
    for (const config of [toAda, toChat]) {
      await failure(destinationChannelFrom({ ...config, secret: 'too short' }, { fetch }).send(notice));
    }
    assert.equal(sent.length, 0);
  });

  it('sends through no email service it does not have', async () => {
    const { fetch, sent } = fakeFetch();
    const other = { ...sender, provider: 'other' } as unknown as EmailServiceSettings;
    const error = await failure(destinationChannelFrom({ ...toAda, settings: other }, { fetch }).send(notice));
    assert.equal(error.message, "The email channel's service is not one a notice can go out through.");
    assert.equal(sent.length, 0);
  });
});

describe('channelFrom', () => {
  it('is the ChannelFactory, and builds each kind of channel', () => {
    const factory: ChannelFactory = channelFrom;
    assert.deepEqual(
      configs.map((config) => factory(config).kind),
      ['email', 'slack', 'telegram'],
    );
  });

  it("keeps every channel's secret out of sight", () => {
    for (const config of configs) {
      const channel = channelFrom(config);
      assert.equal(inspect(channel, { showHidden: true, depth: 10 }).includes(config.secret), false, config.kind);
      assert.equal(JSON.stringify(channel).includes(config.secret), false, config.kind);
    }
  });

  it('refuses a notice that cannot go out, and calls nothing', async () => {
    const { fetch, sent } = fakeFetch();
    for (const config of configs) {
      const error = await failure(channelFrom(config, { fetch }).send({ title: ' ', text: 'Two stamps.' }));
      assert.equal(error.message, 'A notice has a title.', config.kind);
    }
    assert.equal(sent.length, 0);
  });
});
