import { sameFeedOwner } from '@swarm-hls-stream/shared';

import type { AdminApiClient } from './AdminApiClient.js';
import { Logger } from './Logger.js';

/** The slice of {@link AdminApiClient} the boot check asks, so a test can answer it without a socket. */
export type AdminOwnerSource = Pick<AdminApiClient, 'describe' | 'fetchStageSelf' | 'fetchFeedOwner'>;

/**
 * Refuse to come up as an admin-mode uploader whose feeds the admin's catalog can never point at.
 *
 * Every stage signs its feeds with a key of its own, `STREAM_KEY`, and the admin writes the owner it
 * knows for the stage into each catalog entry of the stage's streams, so that owner and this
 * service's signer have to be one address. Nothing else enforces it: with the two apart every report
 * answers 200 and every viewer resolves a feed nobody wrote.
 *
 * Asked once here, and again per declaration in the publish gate:
 *
 * 1. `GET /api/internal/stages/self` with this service's own token. An answer names the stage and
 *    its owner, and a mismatch refuses to start.
 * 2. A 404 there is a caller on the shared token, which belongs to no stage, or an admin older than
 *    stages. Both still sign as the brand key, so the owner compared is the one the admin's public
 *    `/api/config` names for its catalog, as before stages.
 *
 * An admin that cannot be read yet is a warning rather than a refusal, because that is a deploy
 * ordering and the gate covers it. A failed read of the stage is not followed by the config, because
 * the catalog's owner is not this stage's once the stage has a key of its own.
 */
export async function assertAdminSignsAsThisService(
  adminApi: AdminOwnerSource,
  signerOwner: string,
  logger: Pick<Logger, 'info' | 'warn'> = Logger.getInstance(),
): Promise<void> {
  const admin = adminApi.describe();
  const self = await adminApi.fetchStageSelf();

  if (self.kind === 'stage') {
    if (!sameFeedOwner(self.owner, signerOwner)) {
      throw new Error(
        `${admin} knows this service's stage ${self.stageId} as owner ${self.owner}, and this service signs its ` +
          `feeds as ${signerOwner}. STREAM_KEY and the owner the admin knows for this stage have to be one ` +
          "address, or the admin's catalog entries point viewers at feeds nobody writes. Fix the deployment's " +
          'STREAM_KEY in the manager, or the stage the admin holds for it, and restart.',
      );
    }
    logger.info(`[Admin] ${admin} knows this service's stage ${self.stageId} as ${self.owner}, the owner it signs as`);
    return;
  }

  if (self.kind === 'unconfirmed') {
    logger.warn(
      `[Admin] Could not confirm the owner ${admin} knows for this service's stage (${self.reason}). Every ` +
        `declaration is checked against ${signerOwner} at publish time instead`,
    );
    return;
  }

  // No stage for this token: the shared token, or an admin older than stages.
  const feedOwner = await adminApi.fetchFeedOwner();
  if (feedOwner === null) {
    logger.warn(
      `[Admin] ${admin} names no stage for this service's token, and could not confirm that it signs its catalog ` +
        `as ${signerOwner}. Every declaration is checked against it at publish time instead`,
    );
    return;
  }
  if (!sameFeedOwner(feedOwner, signerOwner)) {
    throw new Error(
      `${admin} names no stage for this service's token and signs its catalog as ${feedOwner}, and this service ` +
        `signs its feeds as ${signerOwner}. On a token that is not a stage's own, STREAM_KEY and the owner the ` +
        "admin knows, its catalog's, have to be one address, or the admin's catalog entries point viewers at feeds " +
        'nobody writes. Give this deployment a token of its own in the manager, so the admin knows its stage, or fix ' +
        'its STREAM_KEY, and restart.',
    );
  }
  logger.info(
    `[Admin] ${admin} names no stage for this service's token and signs its catalog as ${feedOwner}, the owner ` +
      'this service signs as',
  );
}
