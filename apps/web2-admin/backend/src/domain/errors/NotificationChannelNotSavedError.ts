import { NOTIFICATION_CHANNEL_NAMES, type NotificationChannelKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A switch or a test of a channel that was never saved, or was removed: there is nothing to switch, and nothing to send
 * a test notice on. The API answers 409 `channel_not_saved` (`NOTIFICATION_CHANNEL_NOT_SAVED_ERROR`).
 */
export class NotificationChannelNotSavedError extends Error {
  constructor(public readonly kind: NotificationChannelKind) {
    super(`The ${NOTIFICATION_CHANNEL_NAMES[kind]} channel is not saved. Save it first.`);
    this.name = 'NotificationChannelNotSavedError';
  }
}
