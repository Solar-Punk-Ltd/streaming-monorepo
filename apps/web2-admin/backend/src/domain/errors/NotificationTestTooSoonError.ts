import { NOTIFICATION_CHANNEL_NAMES, type NotificationChannelKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A test notice asked for while the channel's last one is less than `NOTIFICATION_TEST_EVERY_SECONDS` old: one goes
 * out a minute at most on a channel. The API answers 429 `test_too_soon` (`NOTIFICATION_TEST_TOO_SOON_ERROR`) with
 * `retryAfterSeconds`, and `Retry-After` with the same number. Nothing was sent.
 */
export class NotificationTestTooSoonError extends Error {
  constructor(
    public readonly kind: NotificationChannelKind,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      `A test notice went out on the ${NOTIFICATION_CHANNEL_NAMES[kind]} channel less than a minute ago. Send the next one in ${retryAfterSeconds} ${retryAfterSeconds === 1 ? 'second' : 'seconds'}.`,
    );
    this.name = 'NotificationTestTooSoonError';
  }
}
