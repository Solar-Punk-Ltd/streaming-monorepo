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
  emailAddressProblem,
  EMAIL_RECIPIENTS_MAX,
  emailRecipientsProblems,
  isNotificationChannelKind,
  NOTICE_TITLE_MAX_LENGTH,
  noticeProblem,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_SECRET_MAX_LENGTH,
  SLACK_WEBHOOK_HOST,
  storedChannelSecret,
  storedChannelSettings,
  storedEmailAddress,
  TELEGRAM_API_HOST,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  type EmailChannelSettings,
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
