import {
  CONSOLE_DEFAULT_THEME_PATH,
  type PublicConfig,
  type SetDefaultThemeResponse,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { ConsoleSettingsService } from '../../domain/ConsoleSettingsService.js';
import type { FeedIdentity } from '../../domain/feedIdentity.js';
import { type DefaultThemeBody, defaultThemeSchema } from '../../schemas/console.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, requireAdmin } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';

export interface ConfigRoutesDeps {
  feed: FeedIdentity;
  viewerBaseUrl: string;
  consoleSettings: ConsoleSettingsService;
  requireAuth: RequestHandler;
}

/** The route below the router's mount point, which is `/api/config`. */
const DEFAULT_THEME_ROUTE = CONSOLE_DEFAULT_THEME_PATH.slice('/api/config'.length);

/**
 * `GET /` is unauthenticated on purpose: the feed owner and topic are what any
 * viewer needs to read the catalog from Swarm, the login screen shows the viewer
 * link, and it wears the host's default look before anyone signs in. Nothing
 * secret is in here: no batch id, no keys, no ingest details.
 *
 * Changing the default look is for admins, behind the session and the
 * cross-site check like every other write.
 */
export function createConfigRouter(deps: ConfigRoutesDeps): Router {
  const { feed, viewerBaseUrl, consoleSettings, requireAuth } = deps;
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

  router.put(
    DEFAULT_THEME_ROUTE,
    requireAuth,
    requireAdmin,
    validateBody(defaultThemeSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as DefaultThemeBody;
      const response: SetDefaultThemeResponse = {
        defaultTheme: await consoleSettings.setDefaultTheme(actorOf(req), body.defaultTheme),
      };
      res.json(response);
    }),
  );

  return router;
}
