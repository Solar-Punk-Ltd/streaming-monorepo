import { NOTICE_SERVICE_NAMES, type NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A switch of a notification service that was never saved, or was removed, or a test notice or a Telegram code that
 * would go through it: there is nothing to switch and nothing to send through. The API answers 409
 * `service_not_saved` (`NOTICE_SERVICE_NOT_SAVED_ERROR`).
 */
export class NoticeServiceNotSavedError extends Error {
  constructor(public readonly kind: NoticeServiceKind) {
    super(
      `The ${NOTICE_SERVICE_NAMES[kind]} service is not saved. A user with the admin role sets it up on the Notifications page.`,
    );
    this.name = 'NoticeServiceNotSavedError';
  }
}
