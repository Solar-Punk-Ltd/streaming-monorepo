import http from 'node:http';

import express from 'express';

import { AuthService } from '../domain/AuthService.js';
import { Database } from '../domain/Database.js';
import type { FeedIdentity } from '../domain/feedIdentity.js';
import { IngestService } from '../domain/IngestService.js';
import { Logger } from '../domain/Logger.js';
import { PublishService } from '../domain/PublishService.js';
import { StreamService } from '../domain/StreamService.js';
import { StreamStateService } from '../domain/StreamStateService.js';

import type { SessionCookieConfig } from './cookies.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createRequireAuth } from './middleware/requireAuth.js';
import { createRequireInternalToken } from './middleware/requireInternalToken.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createAuthRouter } from './routes/auth.js';
import { createConfigRouter } from './routes/config.js';
import { createFeedRouter } from './routes/feed.js';
import { createHealthRouter } from './routes/health.js';
import { createInternalRouter } from './routes/internal.js';
import { createStreamsRouter } from './routes/streams.js';

const logger = Logger.getInstance();

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ApiDeps {
  database: Database;
  authService: AuthService;
  streamService: StreamService;
  streamStateService: StreamStateService;
  publishService: PublishService;
  ingestService: IngestService;
  /** Bearer token for /api/internal; never accepted anywhere else. */
  internalApiToken: string;
  feed: FeedIdentity;
  cookie: SessionCookieConfig;
  viewerBaseUrl: string;
}

export interface ApiServerHandle {
  close(): Promise<void>;
}

export function startApiServer(
  deps: ApiDeps,
  port: number,
  host: string,
): ApiServerHandle {
  const app = express();

  app.use(requestLogger);
  // Thumbnails are raw image bodies with their own, much larger limit; see the
  // streams router. Everything else is small JSON.
  app.use(express.json({ limit: '256kb' }));

  const requireAuth = createRequireAuth(deps.authService);

  app.use('/api/health', createHealthRouter(deps.database));
  // Mounted before the session routes and on a path of its own: the uploader's
  // bearer token and the console's session cookie authenticate disjoint
  // surfaces, and nothing is shared between the two but the database.
  app.use(
    '/api/internal',
    createInternalRouter({
      streamStateService: deps.streamStateService,
      requireInternalToken: createRequireInternalToken(deps.internalApiToken),
    }),
  );
  app.use('/api/config', createConfigRouter(deps.feed, deps.viewerBaseUrl));
  app.use(
    '/api/auth',
    createAuthRouter(deps.authService, deps.cookie, requireAuth),
  );
  app.use(
    '/api/feed',
    createFeedRouter({
      publishService: deps.publishService,
      requireAuth,
    }),
  );
  app.use(
    '/api/streams',
    createStreamsRouter({
      streamService: deps.streamService,
      publishService: deps.publishService,
      ingestService: deps.ingestService,
      requireAuth,
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, host, () => {
    logger.info(`[ApiServer] Listening on ${host}:${port}`);
  });

  return {
    async close() {
      return new Promise<void>((resolve, reject) => {
        const forceTimer = setTimeout(() => {
          logger.warn(
            `[ApiServer] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing close`,
          );
          server.closeAllConnections?.();
        }, SHUTDOWN_TIMEOUT_MS);

        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) {
            reject(err);
          } else {
            logger.info('[ApiServer] Server closed');
            resolve();
          }
        });
      });
    },
  };
}
