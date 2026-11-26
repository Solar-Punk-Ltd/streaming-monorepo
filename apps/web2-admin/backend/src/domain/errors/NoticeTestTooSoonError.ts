import { NOTICE_DESTINATION_NAMES, type NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A test notice asked for while the last one to the same destination is less than `NOTIFICATION_TEST_EVERY_SECONDS`
 * old: one goes out a minute at most to a destination. The API answers 429 `test_too_soon`
 * (`NOTIFICATION_TEST_TOO_SOON_ERROR`) with `retryAfterSeconds`, and `Retry-After` with the same number. Nothing was
 * sent.
 */
export class NoticeTestTooSoonError extends Error {
  constructor(
    public readonly kind: NoticeServiceKind,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      `A test notice went to your ${NOTICE_DESTINATION_NAMES[kind].toLowerCase()} less than a minute ago. Send the next one in ${retryAfterSeconds} ${retryAfterSeconds === 1 ? 'second' : 'seconds'}.`,
    );
    this.name = 'NoticeTestTooSoonError';
  }
}
