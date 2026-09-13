import type { PublicConfig } from '@streaming-monorepo/web2-admin-common';
import { Request, Response, Router } from 'express';

import type { FeedIdentity } from '../../domain/feedIdentity.js';

/**
 * Unauthenticated on purpose: the feed owner and topic are what any viewer
 * needs to read the catalog from Swarm, and the login screen shows the viewer
 * link. Nothing secret is in here — no batch id, no keys, no ingest details.
 */
export function createConfigRouter(
  feed: FeedIdentity,
  viewerBaseUrl: string,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const body: PublicConfig = {
      feed: {
        owner: feed.owner,
        topic: feed.topic,
        topicHex: feed.topicHex,
      },
      viewerBaseUrl: viewerBaseUrl || null,
    };
    res.json(body);
  });

  return router;
}
