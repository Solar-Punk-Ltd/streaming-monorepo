import type { PublicConfig } from '@streaming-monorepo/web2-admin-common';
import { Request, Response, Router } from 'express';

import type { ConsoleSettingsService } from '../../domain/ConsoleSettingsService.js';
import type { FeedIdentity } from '../../domain/feedIdentity.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export interface ConfigRoutesDeps {
  feed: FeedIdentity;
  viewerBaseUrl: string;
  consoleSettings: ConsoleSettingsService;
}

/**
 * `GET /` is unauthenticated on purpose: the feed owner and topic are what any
 * viewer needs to read the catalog from Swarm, the login screen shows the viewer
 * link, and it wears the host's default look before anyone signs in. Nothing
 * secret is in here: no batch id, no keys, no ingest details.
 */
export function createConfigRouter(deps: ConfigRoutesDeps): Router {
  const { feed, viewerBaseUrl, consoleSettings } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const body: PublicConfig = {
        feed: {
          owner: feed.owner,
          topic: feed.topic,
          topicHex: feed.topicHex,
        },
        viewerBaseUrl: viewerBaseUrl || null,
        defaultTheme: await consoleSettings.defaultTheme(),
      };
      res.json(body);
    }),
  );

  return router;
}
