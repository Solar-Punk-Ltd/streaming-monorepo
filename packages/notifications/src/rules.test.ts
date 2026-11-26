/**
 * The rules the backend that sends and the console's forms both read.
 *
 * A secret's check is what keeps a call on its service's own host: Slack's webhook URL is the one address a person
 * types, so the shapes it refuses are pinned here. The settings' checks take a request's body as it comes, so they are
 * pinned against the wrong shapes as well as the wrong values.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BREVO_API_HOST,
  channelSecretProblem,
  channelSettingsProblems,
  destinationAddressProblem,
  emailAddressProblem,
  EMAIL_RECIPIENTS_MAX,
  emailRecipientsProblems,
  isNoticeServiceKind,
  isNotificationChannelKind,
  isTelegramBotUsername,
  isTelegramChatCode,
  NOTICE_SERVICE_KINDS,
  NOTICE_TITLE_MAX_LENGTH,
  noticeProblem,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_SECRET_MAX_LENGTH,
  SLACK_WEBHOOK_HOST,
  serviceSecretProblem,
  serviceSettingsProblems,
  storedChannelSecret,
  storedChannelSettings,
  storedDestinationAddress,
  storedEmailAddress,
  storedServiceSettings,
  TELEGRAM_API_HOST,
  TELEGRAM_CHAT_CODE_ALPHABET,
  TELEGRAM_CHAT_CODE_LENGTH,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  telegramStartLink,
  telegramTextSendsCode,
  type EmailChannelSettings,
  type EmailServiceSettings,
} from './rules.js';

const email: EmailChannelSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream alerts',
  recipients: ['ops@example.org'],
};

const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/abcdefABCDEF0123456789xy';
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

describe('the channels', () => {
  it('are email, Slack and Telegram, in that order', () => {
    assert.deepEqual([...NOTIFICATION_CHANNEL_KINDS], ['email', 'slack', 'telegram']);
    assert.equal(isNotificationChannelKind('slack'), true);
    assert.equal(isNotificationChannelKind('mattermost'), false);
    assert.equal(isNotificationChannelKind(undefined), false);
  });

  it('call fixed hosts', () => {
    assert.equal(BREVO_API_HOST, 'api.brevo.com');
    assert.equal(SLACK_WEBHOOK_HOST, 'hooks.slack.com');
    assert.equal(TELEGRAM_API_HOST, 'api.telegram.org');
    assert.equal(TELEGRAM_MESSAGE_MAX_LENGTH, 4096);
  });
});

describe('a secret', () => {
  it('is kept trimmed', () => {
    assert.equal(storedChannelSecret(`  ${SLACK_URL}\n`), SLACK_URL);
  });

  it('is an API key of one line for email', () => {
    assert.equal(channelSecretProblem('email', `xkeysib-${'a'.repeat(64)}-${'B'.repeat(16)}`), null);
    assert.equal(channelSecretProblem('email', `  ${'k'.repeat(20)}  `), null);
    for (const key of ['', 'short', `${'k'.repeat(10)} ${'k'.repeat(10)}`, `${'k'.repeat(10)}\n${'k'.repeat(10)}`]) {
      assert.notEqual(channelSecretProblem('email', key), null, JSON.stringify(key));
    }
  });

  it("is an incoming webhook on Slack's own host for Slack", () => {
    assert.equal(channelSecretProblem('slack', SLACK_URL), null);
    for (const url of [
      '',
      'http://hooks.slack.com/services/T0001/B0001/abcdef',
      'https://hooks.slack.com.example.org/services/T0001/B0001/abcdef',
      'https://example.org/services/T0001/B0001/abcdef',
      'https://hooks.slack.com@example.org/services/T0001/B0001/abcdef',
      'https://hooks.slack.com:8443/services/T0001/B0001/abcdef',
      'https://hooks.slack.com/services/T0001/B0001',
      'https://hooks.slack.com/services/T0001/B0001/abcdef/more',
      'https://hooks.slack.com/services/T0001/B0001/abcdef?x=1',
      'https://hooks.slack.com/services/T0001/B0001/abc#def',
      'https://hooks.slack.com/services/T0001/../abcdef',
      'https://hooks.slack.com/triggers/T0001/123/abcdef',
      `${SLACK_URL}\nhttps://example.org`,
    ]) {
      assert.notEqual(channelSecretProblem('slack', url), null, url);
    }
  });

  it("is a bot's token for Telegram", () => {
    assert.equal(channelSecretProblem('telegram', TELEGRAM_TOKEN), null);
    for (const token of [
      '',
      '1234567890',
      `:${'A'.repeat(35)}`,
      `1234567890:${'A'.repeat(10)}`,
      `bot${TELEGRAM_TOKEN}`,
    ]) {
      assert.notEqual(channelSecretProblem('telegram', token), null, token);
    }
    assert.notEqual(channelSecretProblem('telegram', `1234567890:${'A'.repeat(20)}/sendMessage`), null);
  });

  it('is refused over its longest length, in a sentence that never repeats it', () => {
    const long = 'k'.repeat(NOTIFICATION_SECRET_MAX_LENGTH + 1);
    const problem = channelSecretProblem('email', long);
    assert.notEqual(problem, null);
    assert.equal(problem?.includes('kkkk'), false);
    for (const kind of NOTIFICATION_CHANNEL_KINDS) {
      const refused = channelSecretProblem(kind, 'not a secret of any kind');
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

  it('is on a list of recipients once, and the list holds one to twenty', () => {
    assert.deepEqual(emailRecipientsProblems(['ops@example.org', 'dev@example.org']), []);
    assert.deepEqual(emailRecipientsProblems([]), ['Enter one recipient or more.']);
    assert.deepEqual(emailRecipientsProblems(['ops@example.org', ' OPS@example.org']), [
      'ops@example.org is on the list twice.',
    ]);
    assert.deepEqual(emailRecipientsProblems(['ops']), ['ops: Enter an email address such as name@example.org.']);
    const many = Array.from({ length: EMAIL_RECIPIENTS_MAX + 1 }, (_unused, index) => `ops${index}@example.org`);
    assert.deepEqual(emailRecipientsProblems(many), ['The list holds at most 20 addresses.']);
  });
});

describe("a channel's settings", () => {
  it('for email are a service, a sender and recipients', () => {
    assert.deepEqual(channelSettingsProblems('email', email), []);
    assert.deepEqual(channelSettingsProblems('email', { ...email, senderName: '' }), []);
    assert.equal(channelSettingsProblems('email', { ...email, provider: 'smtp' }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, senderAddress: 'alerts' }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, senderName: 'Alerts <x@example.org>' }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, senderName: 'One\nTwo' }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, recipients: [] }).length, 1);
  });

  it('for email are refused whole when the body has another shape', () => {
    assert.equal(channelSettingsProblems('email', null).length, 1);
    assert.equal(channelSettingsProblems('email', ['ops@example.org']).length, 1);
    assert.equal(channelSettingsProblems('email', {}).length, 4);
    assert.equal(channelSettingsProblems('email', { ...email, recipients: 'ops@example.org' }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, recipients: [1] }).length, 1);
    assert.equal(channelSettingsProblems('email', { ...email, senderName: 7 }).length, 1);
  });

  it('for Slack are none', () => {
    assert.deepEqual(channelSettingsProblems('slack', {}), []);
    assert.equal(channelSettingsProblems('slack', null).length, 1);
  });

  it("for Telegram are a chat's number or a public channel's name", () => {
    for (const chatId of ['-1001234567890', '123456789', ' -42 ', '@channelname', '@Chan_nel1']) {
      assert.deepEqual(channelSettingsProblems('telegram', { chatId }), [], chatId);
    }
    for (const chatId of [
      '',
      '0',
      '-0',
      '0123',
      '12.5',
      '1e9',
      'channelname',
      '@abc',
      '@1channel',
      '@chan-nel',
      '-100 1',
    ]) {
      assert.equal(channelSettingsProblems('telegram', { chatId }).length, 1, JSON.stringify(chatId));
    }
    assert.equal(channelSettingsProblems('telegram', { chatId: -1001234567890 }).length, 1);
    assert.equal(channelSettingsProblems('telegram', {}).length, 1);
  });

  it('are kept trimmed, addresses in lower case, with nothing beside them', () => {
    const typed = {
      ...email,
      senderAddress: ' Alerts@Example.org ',
      senderName: ' Stream alerts ',
      recipients: [' Ops@Example.org'],
      extra: 'dropped',
    };
    assert.deepEqual(storedChannelSettings('email', typed), {
      provider: 'brevo',
      senderAddress: 'alerts@example.org',
      senderName: 'Stream alerts',
      recipients: ['ops@example.org'],
    });
    assert.deepEqual(storedChannelSettings('telegram', { chatId: ' -42 ' }), { chatId: '-42' });
    assert.deepEqual(storedChannelSettings('slack', {}), {});
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

  it('check a secret as the channel of the same kind does', () => {
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
