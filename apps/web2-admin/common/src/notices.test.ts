/**
 * The admin's notice topics and routes, and that the rules of the services and the destinations reach the console and
 * the backend from the shared package through this one door.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as shared from '@streaming-monorepo/notifications/rules';

import { unmarkedStampLevel, unmarkedStampTopic, UNMARKED_STAMP_HOLDERS } from './autoTopUp.js';
import * as common from './index.js';
import {
  MY_NOTICE_TOPICS_PATH,
  MY_TELEGRAM_CHAT_PATH,
  MY_TELEGRAM_CODE_PATH,
  myDestinationEnabledPath,
  myDestinationPath,
  myDestinationTestPath,
  NOTICE_TOPIC_GROUPS,
  NOTICE_TOPIC_NAMES,
  NOTICE_TOPICS,
  noticePeople,
  noticeServiceEnabledPath,
  noticeServicePath,
  noticeTopicsProblem,
  NOTIFICATIONS_PATH,
  STARTING_NOTICE_TOPICS,
  storedNoticeTopics,
  TELEGRAM_CHAT_CODE_SECONDS,
} from './notices.js';
import { SECONDS_PER_DAY } from './stampQuote.js';

describe('the notice topics', () => {
  it('are each listed once, under what sends them, and each has a name', () => {
    assert.deepEqual(
      NOTICE_TOPIC_GROUPS.flatMap((group) => group.topics),
      [...NOTICE_TOPICS],
    );
    for (const topic of NOTICE_TOPICS) assert.notEqual(NOTICE_TOPIC_NAMES[topic], '', topic);
  });

  it('start with the four of stamp auto top-up ticked, and the two of the unmarked stamps unticked', () => {
    assert.deepEqual([...STARTING_NOTICE_TOPICS], ['topups_coming', 'wallet_low', 'topup_failed', 'stamp_expired']);
    assert.deepEqual(
      UNMARKED_STAMP_HOLDERS.map(unmarkedStampTopic),
      NOTICE_TOPICS.filter((topic) => !STARTING_NOTICE_TOPICS.includes(topic)),
    );
  });

  it('are saved as a list of known topics, kept each once in their own order', () => {
    assert.equal(noticeTopicsProblem([]), null);
    assert.equal(noticeTopicsProblem(['unmarked_stage', 'topups_coming']), null);
    assert.notEqual(noticeTopicsProblem(['topups_coming', 'slack']), null);
    assert.notEqual(noticeTopicsProblem('topups_coming'), null);
    assert.notEqual(noticeTopicsProblem(null), null);
    assert.deepEqual(storedNoticeTopics(['unmarked_stage', 'gone', 'topups_coming', 'unmarked_stage']), [
      'topups_coming',
      'unmarked_stage',
    ]);
  });

  it('reach as many people as the view says, and nobody when it names none', () => {
    const view = { reach: [{ topic: 'wallet_low' as const, people: 3 }] };
    assert.equal(noticePeople(view, 'wallet_low'), 3);
    assert.equal(noticePeople(view, 'unmarked_stage'), 0);
  });
});

describe('the notification routes', () => {
  it("sit under /api/notifications: the services, and under /me the signed-in user's own", () => {
    assert.equal(NOTIFICATIONS_PATH, '/api/notifications');
    assert.equal(noticeServicePath('email'), '/api/notifications/services/email');
    assert.equal(noticeServiceEnabledPath('telegram'), '/api/notifications/services/telegram/enabled');
    assert.equal(myDestinationPath('email'), '/api/notifications/me/destinations/email');
    assert.equal(myDestinationEnabledPath('email'), '/api/notifications/me/destinations/email/enabled');
    assert.equal(myDestinationTestPath('telegram'), '/api/notifications/me/destinations/telegram/test');
    assert.equal(MY_NOTICE_TOPICS_PATH, '/api/notifications/me/topics');
    assert.equal(MY_TELEGRAM_CODE_PATH, '/api/notifications/me/telegram/code');
    assert.equal(MY_TELEGRAM_CHAT_PATH, '/api/notifications/me/telegram/chat');
  });

  it('keep a code to find a chat for ten minutes', () => {
    assert.equal(TELEGRAM_CHAT_CODE_SECONDS, 600);
  });

  it('read every rule of the services and the destinations from the shared package, under its own name', () => {
    const exported = common as Record<string, unknown>;
    for (const [name, value] of Object.entries(shared)) {
      assert.equal(exported[name], value, name);
    }
  });
});

describe('an unmarked stamp', () => {
  it('is low under Top up when under, at its last notice under two days, and nothing to tell of above', () => {
    const settings = { topUpUnderDays: 7 };
    assert.equal(unmarkedStampLevel(7 * SECONDS_PER_DAY, settings), null);
    assert.equal(unmarkedStampLevel(7 * SECONDS_PER_DAY - 1, settings), 'low');
    assert.equal(unmarkedStampLevel(2 * SECONDS_PER_DAY, settings), 'low');
    assert.equal(unmarkedStampLevel(2 * SECONDS_PER_DAY - 1, settings), 'last');
    assert.equal(unmarkedStampLevel(1, settings), 'last');
    assert.equal(unmarkedStampLevel(2 * SECONDS_PER_DAY - 1, { topUpUnderDays: 2 }), 'last');
  });
});
