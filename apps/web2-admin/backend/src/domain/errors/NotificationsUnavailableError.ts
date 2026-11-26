import { BRAND_WALLET_SECRET_KEY } from '../../utils/fundingSettings.js';

/**
 * A service's save, a test notice or a Telegram lookup, refused because the admin has no `BRAND_WALLET_SECRET`: a
 * service's secret is sealed under a key derived from it and opened with that key, so without it no secret can be saved
 * or opened. The API answers 409 `notifications_unavailable` (`NOTIFICATIONS_UNAVAILABLE_ERROR`). Nothing was saved or
 * sent.
 */
export class NotificationsUnavailableError extends Error {
  constructor() {
    super(
      `The admin has no ${BRAND_WALLET_SECRET_KEY}, which the notification services' secrets are kept under, so no service can be saved and no notice can go out.`,
    );
    this.name = 'NotificationsUnavailableError';
  }
}
