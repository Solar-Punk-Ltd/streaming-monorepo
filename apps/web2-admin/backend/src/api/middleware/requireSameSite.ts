import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-monorepo/web2-admin-common';
import { createSameSiteGate } from '@streaming-monorepo/web-auth';

export type { RequestOrigin } from '@streaming-monorepo/web-auth';

/**
 * The admin's cross-site gate: a write needs the header only its console
 * sends. Reads are never refused, so an image or a thumbnail can still be
 * opened in a tab of its own.
 */
export const { crossSiteReason, requireSameSite } = createSameSiteGate({
  header: REQUESTED_WITH_HEADER,
  value: REQUESTED_WITH_VALUE,
});
