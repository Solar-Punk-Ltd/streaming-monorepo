import { NOTICE_DESTINATION_NAMES, type NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A switch or a test of the signed-in user's destination on a service, which they never saved or removed: there is
 * nothing to switch and nowhere to send a test notice. The API answers 409 `destination_not_saved`
 * (`NOTICE_DESTINATION_NOT_SAVED_ERROR`).
 */
export class NoticeDestinationNotSavedError extends Error {
  constructor(public readonly kind: NoticeServiceKind) {
    super(`You have no ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()} saved. Save it first.`);
    this.name = 'NoticeDestinationNotSavedError';
  }
}
