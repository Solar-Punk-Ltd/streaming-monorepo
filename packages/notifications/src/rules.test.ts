/**
 * The rules the backend that sends and the console's forms both read.
 *
 * A secret's check is what keeps a call on its service's own host: a bot's token goes into the path Telegram is called
 * on, so the shapes it refuses are pinned here. The settings' checks take a request's body as it comes, so they are
 * pinned against the wrong shapes as well as the wrong values.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BREVO_API_HOST,
  destinationAddressProblem,
  emailAddressProblem,
  isNoticeServiceKind,
  isTelegramBotUsername,
  isTelegramChatCode,
  NOTICE_SERVICE_KINDS,
  NOTICE_TITLE_MAX_LENGTH,
  noticeProblem,
  NOTIFICATION_SECRET_MAX_LENGTH,
  serviceSecretProblem,
  serviceSettingsProblems,
  storedChannelSecret,
  storedDestinationAddress,
  storedEmailAddress,
  storedServiceSettings,
  TELEGRAM_API_HOST,
  TELEGRAM_CHAT_CODE_ALPHABET,
  TELEGRAM_CHAT_CODE_LENGTH,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  telegramStartLink,
  telegramTextSendsCode,
  type EmailServiceSettings,
} from './rules.js';

const TELEGRAM_TOKEN = `1234567890:${'A'.repeat(35)}`;

describe('the notice', () => {
  it('has a one-line title and a text', () => {
    assert.equal(noticeProblem({ title: 'Top-ups coming up', text: 'Two stamps.' }), null);
    assert.notEqual(noticeProblem({ title: ' ', text: 'Two stamps.' }), null);
    assert.notEqual(noticeProblem({ title: 'One\nTwo', text: 'Two stamps.' }), null);
    assert.notEqual(noticeProblem({ title: 'a'.repeat(NOTICE_TITLE_MAX_LENGTH + 1), text: 'Two stamps.' }), null);
    assert.equal(noticeProblem({ title: 'a'.repeat(NOTICE_TITLE_MAX_LENGTH), text: 'Two stamps.' }), null);
    assert.notEqual(noticeProblem({ title: 'Top-ups coming up', text: '\n' }), null);
  });
});

describe('the outbound calls', () => {
  it('go to fixed hosts', () => {
    assert.equal(BREVO_API_HOST, 'api.brevo.com');
    assert.equal(TELEGRAM_API_HOST, 'api.telegram.org');
    assert.equal(TELEGRAM_MESSAGE_MAX_LENGTH, 4096);
  });
});

describe("a service's secret", () => {
  it('is kept trimmed', () => {
    assert.equal(storedChannelSecret(`  ${TELEGRAM_TOKEN}\n`), TELEGRAM_TOKEN);
  });

  it('is an API key of one line for email', () => {
    assert.equal(serviceSecretProblem('email', `xkeysib-${'a'.repeat(64)}-${'B'.repeat(16)}`), null);
    assert.equal(serviceSecretProblem('email', `  ${'k'.repeat(20)}  `), null);
    for (const key of ['', 'short', `${'k'.repeat(10)} ${'k'.repeat(10)}`, `${'k'.repeat(10)}\n${'k'.repeat(10)}`]) {
      assert.notEqual(serviceSecretProblem('email', key), null, JSON.stringify(key));
    }
  });

  it("is a bot's token for Telegram", () => {
    assert.equal(serviceSecretProblem('telegram', TELEGRAM_TOKEN), null);
    for (const token of [
      '',
      '1234567890',
      `:${'A'.repeat(35)}`,
      `1234567890:${'A'.repeat(10)}`,
      `bot${TELEGRAM_TOKEN}`,
    ]) {
      assert.notEqual(serviceSecretProblem('telegram', token), null, token);
    }
    assert.notEqual(serviceSecretProblem('telegram', `1234567890:${'A'.repeat(20)}/sendMessage`), null);
  });

  it('is refused over its longest length, in a sentence that never repeats it', () => {
    const long = 'k'.repeat(NOTIFICATION_SECRET_MAX_LENGTH + 1);
    const problem = serviceSecretProblem('email', long);
    assert.notEqual(problem, null);
    assert.equal(problem?.includes('kkkk'), false);
    for (const kind of NOTICE_SERVICE_KINDS) {
      const refused = serviceSecretProblem(kind, 'not a secret of any kind');
      assert.notEqual(refused, null, kind);
      assert.equal(refused?.includes('not a secret'), false, kind);
    }
  });
});

describe('an email address', () => {
  it('is kept trimmed and in lower case', () => {
    assert.equal(storedEmailAddress('  Ops@Example.ORG '), 'ops@example.org');
  });

  it('is a name, an @ and a host with a dot', () => {
    for (const address of ['ops@example.org', 'first.last+tag@mail.example.org', ' Ops@Example.org ']) {
      assert.equal(emailAddressProblem(address), null, address);
    }
    for (const address of [
      '',
      '   ',
      'ops',
      'ops@example',
      'o ps@example.org',
      'a@b@example.org',
      'ops@example.org.',
    ]) {
      assert.notEqual(emailAddressProblem(address), null, JSON.stringify(address));
    }
    assert.notEqual(emailAddressProblem(`${'a'.repeat(250)}@example.org`), null);
  });
});

const emailService: EmailServiceSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream alerts',
};

describe('the services', () => {
  it('are email and Telegram, in that order', () => {
    assert.deepEqual([...NOTICE_SERVICE_KINDS], ['email', 'telegram']);
    assert.equal(isNoticeServiceKind('telegram'), true);
    assert.equal(isNoticeServiceKind('slack'), false);
    assert.equal(isNoticeServiceKind(undefined), false);
  });

  it('take a provider and a sender for email, and name no recipient', () => {
    assert.deepEqual(serviceSettingsProblems('email', emailService), []);
    assert.deepEqual(serviceSettingsProblems('email', { ...emailService, senderName: '' }), []);
    assert.equal(serviceSettingsProblems('email', { ...emailService, provider: 'smtp' }).length, 1);
    assert.equal(serviceSettingsProblems('email', { ...emailService, senderAddress: 'alerts' }).length, 1);
    assert.equal(serviceSettingsProblems('email', { ...emailService, senderName: 'One\nTwo' }).length, 1);
    assert.equal(serviceSettingsProblems('email', {}).length, 3);
    assert.equal(serviceSettingsProblems('email', null).length, 1);
    assert.deepEqual(
      storedServiceSettings('email', {
        ...emailService,
        senderAddress: ' Alerts@Example.org ',
        senderName: ' Stream alerts ',
        recipients: ['ops@example.org'],
      } as EmailServiceSettings),
      emailService,
    );
  });

  it('take no settings for Telegram, and keep none a form sent', () => {
    assert.deepEqual(serviceSettingsProblems('telegram', {}), []);
    assert.equal(serviceSettingsProblems('telegram', 'bot').length, 1);
    assert.deepEqual(storedServiceSettings('telegram', { chatId: '1' } as unknown as Record<string, never>), {});
  });

  it('check their secret', () => {
    assert.equal(serviceSecretProblem('telegram', TELEGRAM_TOKEN), null);
    assert.notEqual(serviceSecretProblem('telegram', 'not a token'), null);
    assert.equal(serviceSecretProblem('email', 'xkeysib-made-up-for-the-test'), null);
    assert.notEqual(serviceSecretProblem('email', 'short'), null);
  });
});

describe('a destination', () => {
  it('is an email address on the email service, kept trimmed and in lower case', () => {
    assert.equal(destinationAddressProblem('email', 'ops@example.org'), null);
    assert.notEqual(destinationAddressProblem('email', 'ops'), null);
    assert.notEqual(destinationAddressProblem('email', ''), null);
    assert.notEqual(destinationAddressProblem('email', ['ops@example.org']), null);
    assert.equal(storedDestinationAddress('email', ' Ops@Example.org '), 'ops@example.org');
  });

  it("is a chat's id or a public channel's name on Telegram, kept trimmed", () => {
    for (const chatId of ['123456789', '-1001234567890', '@channelname']) {
      assert.equal(destinationAddressProblem('telegram', chatId), null, chatId);
    }
    for (const chatId of ['', '0', '012', '12.5', 'channelname', '@ab', 'https://t.me/channelname']) {
      assert.notEqual(destinationAddressProblem('telegram', chatId), null, chatId);
    }
    assert.notEqual(destinationAddressProblem('telegram', 123456789), null);
    assert.equal(storedDestinationAddress('telegram', ' -1001234567890 '), '-1001234567890');
  });

  it("on Telegram is nothing like a chat's number or a public channel's name", () => {
    for (const chatId of [' -42 ', '@Chan_nel1']) {
      assert.equal(destinationAddressProblem('telegram', chatId), null, chatId);
    }
    for (const chatId of ['-0', '0123', '1e9', '@abc', '@1channel', '@chan-nel', '-100 1']) {
      assert.notEqual(destinationAddressProblem('telegram', chatId), null, JSON.stringify(chatId));
    }
  });
});

describe("the email service's sender", () => {
  it('has a name of one line with no quotation mark, angle bracket or backslash', () => {
    for (const senderName of ['Alerts <x@example.org>', 'Say "hi"', 'Back\\slash', 7]) {
      assert.equal(
        serviceSettingsProblems('email', { ...emailService, senderName }).length,
        1,
        JSON.stringify(senderName),
      );
    }
    assert.equal(serviceSettingsProblems('email', ['alerts@example.org']).length, 1);
  });
});

describe("the code that finds one's Telegram chat", () => {
  const code = 'ABCDEFGH23';

  it('is ten characters of its alphabet, which leaves out the ones read for one another', () => {
    assert.equal(TELEGRAM_CHAT_CODE_LENGTH, 10);
    for (const confused of ['I', 'L', 'O', '0', '1']) {
      assert.equal(TELEGRAM_CHAT_CODE_ALPHABET.includes(confused), false, confused);
    }
    assert.equal(isTelegramChatCode(code), true);
    assert.equal(isTelegramChatCode(TELEGRAM_CHAT_CODE_ALPHABET.slice(0, TELEGRAM_CHAT_CODE_LENGTH)), true);
    assert.equal(isTelegramChatCode('ABCDEFGH2'), false);
    assert.equal(isTelegramChatCode('ABCDEFGH2O'), false);
    assert.equal(isTelegramChatCode('abcdefgh23'), false);
    assert.equal(isTelegramChatCode(undefined), false);
  });

  it('is sent by a message that holds it alone, or after /start', () => {
    assert.equal(telegramTextSendsCode(code, code), true);
    assert.equal(telegramTextSendsCode(` ${code.toLowerCase()}\n`, code), true);
    assert.equal(telegramTextSendsCode(`/start ${code}`, code), true);
    assert.equal(telegramTextSendsCode(`/start@stream_alerts_bot ${code}`, code), true);
    assert.equal(telegramTextSendsCode(`my code is ${code}`, code), false);
    assert.equal(telegramTextSendsCode('/start', code), false);
    assert.equal(telegramTextSendsCode(`${code}X`, code), false);
    assert.equal(telegramTextSendsCode('not a code', 'not a code'), false);
  });

  it("goes in the bot's start link, which takes these characters", () => {
    assert.equal(isTelegramBotUsername('stream_alerts_bot'), true);
    assert.equal(isTelegramBotUsername('@stream_alerts_bot'), false);
    assert.equal(isTelegramBotUsername('bot'), false);
    assert.equal(telegramStartLink('stream_alerts_bot', code), `https://t.me/stream_alerts_bot?start=${code}`);
    assert.match(TELEGRAM_CHAT_CODE_ALPHABET, /^[A-Za-z0-9_-]+$/);
  });
});
