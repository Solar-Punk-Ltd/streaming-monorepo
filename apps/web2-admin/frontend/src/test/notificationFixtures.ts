import type {
  NotificationChannelKind,
  NotificationChannelView,
  NotificationsView,
} from '@streaming-monorepo/web2-admin-common';

/** A channel never saved: off, with no settings, nothing sent and no test. */
export function unsavedChannel(kind: NotificationChannelKind): NotificationChannelView {
  return {
    kind,
    saved: false,
    enabled: false,
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    waiting: 0,
    settings: null,
    savedBy: null,
    savedAt: null,
    lastTestAt: null,
    lastTestError: null,
  } as NotificationChannelView;
}

/** The email channel saved by an operator and on, sending through Brevo to one recipient. */
export function savedEmail(over: Partial<NotificationChannelView> = {}): NotificationChannelView {
  return {
    ...unsavedChannel('email'),
    saved: true,
    enabled: true,
    settings: {
      provider: 'brevo',
      senderAddress: 'alerts@example.org',
      senderName: 'Stream Admin',
      recipients: ['ops@example.org'],
    },
    savedBy: 'operator',
    savedAt: '2026-10-04T08:00:00.000Z',
    ...over,
  } as NotificationChannelView;
}

/** The Telegram channel saved by an operator and on, writing to a group. */
export function savedTelegram(over: Partial<NotificationChannelView> = {}): NotificationChannelView {
  return {
    ...unsavedChannel('telegram'),
    saved: true,
    enabled: true,
    settings: { chatId: '-1001234567890' },
    savedBy: 'operator',
    savedAt: '2026-10-04T08:00:00.000Z',
    ...over,
  } as NotificationChannelView;
}

/** The page's view: channels can be saved, and every channel is as given or never saved. */
export function makeNotificationsView(
  channels: Partial<Record<NotificationChannelKind, NotificationChannelView>> = {},
  available = true,
): NotificationsView {
  return {
    available,
    channels: [
      channels.email ?? unsavedChannel('email'),
      channels.slack ?? unsavedChannel('slack'),
      channels.telegram ?? unsavedChannel('telegram'),
    ],
  };
}
