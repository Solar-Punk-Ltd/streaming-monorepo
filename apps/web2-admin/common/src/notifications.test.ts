/**
 * The admin's notification routes and what counts as notifications being on, and that the channel rules reach the
 * console and the backend from the shared package through this one door.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as shared from '@streaming-monorepo/notifications/rules';

import * as common from './index.js';
import { NOTIFICATION_TEST_EVERY_SECONDS, NOTIFICATION_WAIT_SECONDS, NOTIFICATIONS_PATH } from './notices.js';
import {
  notificationChannelEnabledPath,
  notificationChannelPath,
  notificationChannelTestPath,
  notificationsOn,
} from './notifications.js';

describe('the notification routes', () => {
  it('sit under /api/notifications, one set for each channel', () => {
    assert.equal(NOTIFICATIONS_PATH, '/api/notifications');
    assert.equal(notificationChannelPath('email'), '/api/notifications/channels/email');
    assert.equal(notificationChannelEnabledPath('slack'), '/api/notifications/channels/slack/enabled');
    assert.equal(notificationChannelTestPath('telegram'), '/api/notifications/channels/telegram/test');
  });

  it('take one test a minute on a channel, and keep a waiting notice for a day', () => {
    assert.equal(NOTIFICATION_TEST_EVERY_SECONDS, 60);
    assert.equal(NOTIFICATION_WAIT_SECONDS, 86_400);
  });
});

describe('notifications', () => {
  it('are on when one saved channel is on', () => {
    assert.equal(notificationsOn([]), false);
    assert.equal(notificationsOn([{ saved: false, enabled: false }]), false);
    assert.equal(notificationsOn([{ saved: true, enabled: false }]), false);
    assert.equal(notificationsOn([{ saved: false, enabled: true }]), false);
    assert.equal(
      notificationsOn([
        { saved: true, enabled: false },
        { saved: true, enabled: true },
      ]),
      true,
    );
  });

  it('read every channel rule from the shared package, under its own name', () => {
    const exported = common as Record<string, unknown>;
    for (const [name, value] of Object.entries(shared)) {
      assert.equal(exported[name], value, name);
    }
  });
});
