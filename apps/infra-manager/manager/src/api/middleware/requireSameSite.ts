import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-infra-manager/common';
import { createSameSiteGate } from '@streaming-monorepo/web-auth';

export type { RequestOrigin } from '@streaming-monorepo/web-auth';

/**
 * The manager's cross-site gate: a write needs the header only its own pages
 * send. Both live update streams are reads, which the gate never refuses,
 * because `EventSource` opens them with no headers of its own.
 */
export const { crossSiteReason, requireSameSite } = createSameSiteGate({
  header: REQUESTED_WITH_HEADER,
  value: REQUESTED_WITH_VALUE,
});
