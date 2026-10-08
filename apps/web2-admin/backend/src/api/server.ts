import http from 'node:http';

import { FUNDING_PATH, VERSION_PATH, type VersionInfo } from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { AuthService } from '../domain/auth/AuthService.js';
import type { CatalogueBatchService } from '../domain/CatalogueBatch.js';
import type { CatalogueMoveService } from '../domain/CatalogueMove.js';
import { Database } from '../domain/Database.js';
import type { FeedIdentity } from '../domain/feedIdentity.js';
import type { FundingService } from '../domain/funding/FundingService.js';
import { IngestService } from '../domain/IngestService.js';
import { LadderService } from '../domain/LadderService.js';
import { Logger } from '../domain/Logger.js';
import { PublishService } from '../domain/PublishService.js';
import { StageService } from '../domain/StageService.js';
import { StreamService } from '../domain/StreamService.js';
import { StreamStateService } from '../domain/StreamStateService.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createRequireAuth } from './middleware/requireAuth.js';
import { createRequireInternalToken } from './middleware/requireInternalToken.js';
import { createRequireUploaderToken, type UploaderTokenStore } from './middleware/requireUploaderToken.js';
import { requireSameSite } from './middleware/requireSameSite.js';
import { requestLogger } from './middleware/requestLogger.js';
import { createAuthRouter } from './routes/auth.js';
import { createConfigRouter } from './routes/config.js';
import { createFeedRouter } from './routes/feed.js';
import { createFundingRouter } from './routes/funding.js';
import { createHealthRouter } from './routes/health.js';
import { createInternalRouter } from './routes/internal.js';
import { createCatalogueStampRouter, createStagesRouter } from './routes/stages.js';
import { createStreamsRouter } from './routes/streams.js';
import { createVersionRouter } from './routes/version.js';

const logger = Logger.getInstance();

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ApiDeps {
  database: Database;
  authService: AuthService;
  streamService: StreamService;
  streamStateService: StreamStateService;
  ladderService: LadderService;
  publishService: PublishService;
  ingestService: IngestService;
  stageService: StageService;
  catalogueBatch: CatalogueBatchService;
  /** Moving the catalogue's history onto another batch, started from the Stages page. */
  catalogueMove: CatalogueMoveService;
  /** The Funding page: the brand wallet, the nodes' pins, and sends relayed through the manager. */
  fundingService: FundingService;
  /**
   * The registrar token: the only one the manager's routes under /api/internal take. An uploader's routes refuse it.
   * Never accepted anywhere else.
   */
  internalApiToken: string;
  /** Where an uploader's own token is looked up by its sha256: the stages the manager pushed. */
  uploaderTokens: UploaderTokenStore;
  feed: FeedIdentity;
  viewerBaseUrl: string;
  /** The build this process runs, as the deploy built it into the image. */
  version: VersionInfo;
}

export interface ApiServerHandle {
  close(): Promise<void>;
}

export function startApiServer(deps: ApiDeps, port: number, host: string): ApiServerHandle {
  const app = express();

  app.use(requestLogger);

  // Thumbnails are raw image bodies with their own, much larger limit; see the
  // streams router. Everything else is small JSON.
  const json = express.json({ limit: '256kb' });

  // The uploader's and the manager's routes, mounted ahead of the cross-site
  // check and with a body parser of their own.
  //
  // /api/internal is for machine callers: swarm-hls-stream posts from a server,
  // and the manager pushes stage records from one, with no Origin, no
  // Sec-Fetch-Site and no custom header, and each authenticates
  // with a bearer token that no browser holds: the manager with the registrar
  // token, an uploader with its stage's own token. Putting it behind requireSameSite
  // would refuse every report it makes and break the live streaming loop, while
  // buying nothing: a cross-site page cannot forge the token either, and the
  // session cookie is never accepted here. Mounted first so the check that
  // follows never sees these requests at all.
  app.use(
    '/api/internal',
    json,
    createInternalRouter({
      streamStateService: deps.streamStateService,
      ladderService: deps.ladderService,
      stageService: deps.stageService,
      requireRegistrarToken: createRequireInternalToken(deps.internalApiToken),
      requireUploaderToken: createRequireUploaderToken({
        registrarToken: deps.internalApiToken,
        stages: deps.uploaderTokens,
      }),
    }),
  );

  // Ahead of the body parser: a write from another site is refused before its
  // body is read, not after.
  app.use(requireSameSite);
  app.use(json);

  const requireAuth = createRequireAuth(deps.authService);

  app.use('/api/health', createHealthRouter(deps.database));
  app.use('/api/config', createConfigRouter(deps.feed, deps.viewerBaseUrl));
  app.use('/api/auth', createAuthRouter(deps.authService, requireAuth));
  app.use(VERSION_PATH, createVersionRouter({ version: deps.version, requireAuth }));
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
  app.use('/api/stages', createStagesRouter({ stageService: deps.stageService, requireAuth }));
  app.use(
    '/api/catalogue-stamp',
    createCatalogueStampRouter({
      stageService: deps.stageService,
      catalogueBatch: deps.catalogueBatch,
      catalogueMove: deps.catalogueMove,
      requireAuth,
    }),
  );

  app.use(
    FUNDING_PATH,
    createFundingRouter({ fundingService: deps.fundingService, authService: deps.authService, requireAuth }),
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
          logger.warn(`[ApiServer] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing close`);
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
