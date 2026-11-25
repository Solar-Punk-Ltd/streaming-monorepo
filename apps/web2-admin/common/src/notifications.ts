/**
 * The admin's notifications: the channels a notice goes out on, set on the Notifications page, and what that page and
 * the Funding page's Auto top-up tab show of them. `docs/architecture/notifications.md` is the design.
 *
 * The channels, their settings and the checks of those are the shared notifications package's, re-exported here, so
 * the console's forms and the API refuse the same values. What is written here is the admin's own: its routes and
 * what they answer. Every moment on the wire is ISO 8601.
 */

import type {
  NotificationChannelKind,
  NotificationChannelSettingsByKind,
} from '@streaming-monorepo/notifications/rules';

export * from '@streaming-monorepo/notifications/rules';

/** `GET`: the Notifications page's view. */
export const NOTIFICATIONS_PATH = '/api/notifications';

/** `PUT`: save a channel, behind the operator's password. `DELETE`: remove it, with its secret. */
export function notificationChannelPath(kind: NotificationChannelKind): string {
  return `${NOTIFICATIONS_PATH}/channels/${kind}`;
}

/** `PUT`: switch a saved channel on or off. */
export function notificationChannelEnabledPath(kind: NotificationChannelKind): string {
  return `${notificationChannelPath(kind)}/enabled`;
}

/** `POST`: send a test notice on a saved channel. */
export function notificationChannelTestPath(kind: NotificationChannelKind): string {
  return `${notificationChannelPath(kind)}/test`;
}

/** The least time between two test notices on one channel: a minute. */
export const NOTIFICATION_TEST_EVERY_SECONDS = 60;

/**
 * How long a notice waits for a channel that could not take it while another did: a day from when it was raised.
 * After that it is dropped.
 */
export const NOTIFICATION_WAIT_SECONDS = 24 * 60 * 60;

/** 409: the admin has no secret to seal a channel's secret under, so no channel can be saved. */
export const NOTIFICATIONS_UNAVAILABLE_ERROR = 'notifications_unavailable';

/** 409: the channel named was never saved, so there is nothing to switch or to test. */
export const NOTIFICATION_CHANNEL_NOT_SAVED_ERROR = 'channel_not_saved';

/**
 * 429: a test notice went out on this channel less than {@link NOTIFICATION_TEST_EVERY_SECONDS} ago. The answer
 * carries `retryAfterSeconds`.
 */
export const NOTIFICATION_TEST_TOO_SOON_ERROR = 'test_too_soon';

/**
 * `PUT /api/notifications/channels/:kind`: save the channel's settings and its secret, behind the operator's password
 * as a send from the brand wallet is: 401 `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked
 * out. The settings and the secret are checked by `channelSettingsProblems` and `channelSecretProblem`: 400
 * `validation_error` with a sentence for each in `problems`.
 *
 * `secret` null keeps the stored secret, and is refused for a channel that has none. A channel saved for the first
 * time starts on, and a later save keeps its switch.
 */
export interface NotificationChannelSaveRequest<K extends NotificationChannelKind = NotificationChannelKind> {
  password: string;
  settings: NotificationChannelSettingsByKind[K];
  secret: string | null;
}

/** `PUT /api/notifications/channels/:kind/enabled`: switch a saved channel on or off. A session is enough. */
export interface NotificationChannelEnabledRequest {
  enabled: boolean;
}

/** How one channel stands, as the Notifications page and the Auto top-up tab show it. */
export interface NotificationChannelStatus {
  kind: NotificationChannelKind;
  /** Whether it was saved, with its settings and its secret. One never saved is off. */
  saved: boolean;
  /** Whether notices go out on it. */
  enabled: boolean;
  /** When it last took a notice, or null. A test notice does not count. */
  lastSentAt: string | null;
  /** Why its last notice could not be sent, in a sentence, or null once one went out after it. */
  lastError: string | null;
  /** When that was, or null. */
  lastErrorAt: string | null;
  /** How many notices wait for it: ones another channel took and this one could not. */
  waiting: number;
}

/**
 * One channel on the Notifications page: how it stands, its settings, who saved it, and how its last test went. Its
 * secret is in no answer: `saved` says there is one.
 */
export type NotificationChannelView = {
  [K in NotificationChannelKind]: NotificationChannelStatus & {
    kind: K;
    /** Its settings, or null while it was never saved. */
    settings: NotificationChannelSettingsByKind[K] | null;
    /** Who last saved it and when, or null while it was never saved. */
    savedBy: string | null;
    savedAt: string | null;
    /** When a test notice was last sent on it, or null. */
    lastTestAt: string | null;
    /** Why that test could not be sent, in a sentence, or null when it went out or none was sent. */
    lastTestError: string | null;
  };
}[NotificationChannelKind];

/** `GET /api/notifications`, and what a save, a switch and a removal answer. */
export interface NotificationsView {
  /**
   * Whether a channel can be saved: the admin has `BRAND_WALLET_SECRET`, which the channels' secrets are sealed
   * under. False, a save answers 409 `notifications_unavailable`.
   */
  available: boolean;
  /** Every channel, in the order of `NOTIFICATION_CHANNEL_KINDS`, saved or not. */
  channels: NotificationChannelView[];
}

/**
 * `POST /api/notifications/channels/:kind/test`: what became of the test notice. It goes out on the saved channel
 * whether that is on or off, and says who asked for it and when. It counts in no rule: `lastSentAt`, `lastError` and
 * the waiting notices stay as they were.
 */
export interface NotificationTestResponse {
  /** Whether the service took it. */
  sent: boolean;
  /** Why it could not be sent, in a sentence, or null. */
  error: string | null;
  view: NotificationsView;
}

/** Whether notifications are on: one channel or more is. With none, a view is the only place a notice shows. */
export function notificationsOn(channels: readonly Pick<NotificationChannelStatus, 'saved' | 'enabled'>[]): boolean {
  return channels.some((channel) => channel.saved && channel.enabled);
}
