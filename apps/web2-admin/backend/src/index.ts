import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@streaming-monorepo/web2-admin-common';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/auth/AuthService.js';
import { PostgresCredentialRepository } from './domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from './domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from './domain/auth/PostgresUserRepository.js';
import { SessionSweep, startSessionSweep } from './domain/auth/sessionSweep.js';
import { BeeFeedGateway } from './domain/BeeFeedGateway.js';
import { CatalogueBatchService } from './domain/CatalogueBatch.js';
import { CatalogueMoveService } from './domain/CatalogueMove.js';
import { CatalogueMoveRepository } from './domain/CatalogueMoveRepository.js';
import { Database } from './domain/Database.js';
import { FakeFeedGateway } from './domain/FakeFeedGateway.js';
import { FeedBootCheckRunner } from './domain/feedBootCheck.js';
import type { CatalogueRestamper, FeedGateway } from './domain/FeedGateway.js';
import { feedIdentityFrom } from './domain/feedIdentity.js';
import { FeedWriteRepository } from './domain/FeedWriteRepository.js';
import { BrandWallet } from './domain/funding/BrandWallet.js';
import { BrandWalletRepository } from './domain/funding/BrandWalletRepository.js';
import { IngestService } from './domain/IngestService.js';
import { LadderService } from './domain/LadderService.js';
import { Logger } from './domain/Logger.js';
import { Mutex } from './domain/Mutex.js';
import { PostgresAuditLog } from './domain/PostgresAuditLog.js';
import { PublishService } from './domain/PublishService.js';
import { resetOrphanedPublishing } from './domain/resetOrphanedPublishing.js';
import { CatalogueStampRepository, StageRepository } from './domain/StageRepository.js';
import { StageService } from './domain/StageService.js';
import { StreamRenditionRepository } from './domain/StreamRenditionRepository.js';
import { StreamRepository } from './domain/StreamRepository.js';
import { StreamService } from './domain/StreamService.js';
import { StreamStateService } from './domain/StreamStateService.js';
import { config } from './utils/config.js';
import { getErrorStack } from './utils/errorUtils.js';
import { retiredEnvKeysSet } from './utils/retiredEnv.js';

const logger = Logger.getInstance();

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable>';
  }
}

/** Enough of a secret to recognise it in a log, not enough to use it. */
function redactSecret(value: string): string {
  if (value === '') return '(unset)';
  return `${value.slice(0, 6)}…(${value.length} chars)`;
}

function logStartupConfig(owner: string, topicHex: string): void {
  logger.info('[Boot] configuration:');
  logger.info(`[Boot]   listen: ${config.host}:${config.port}`);
  logger.info(`[Boot]   database: ${redactDatabaseUrl(config.databaseUrl)}`);
  logger.info(
    `[Boot]   sessions: idle ${SESSION_IDLE_TIMEOUT_MS / 3_600_000}h, absolute ${
      SESSION_ABSOLUTE_TIMEOUT_MS / 86_400_000
    }d, cookie Secure decided per request from X-Forwarded-Proto`,
  );
  logger.info(
    `[Boot]   feed gateway: ${config.feedGateway}, through the catalogue stamp the manager pushes${
      config.feedGateway === 'fake' ? ' (none needed while fake)' : ''
    }`,
  );
  logger.info(`[Boot]   feed key: ${redactSecret(config.feedPrivateKey)}`);
  logger.info(`[Boot]   feed: owner ${owner} topic "${config.feedTopic}" (${topicHex})`);
  logger.info(`[Boot]   viewer: ${config.viewerBaseUrl || '(unset → no player links)'}`);
  logger.info(`[Boot]   internal API token: ${redactSecret(config.internalApiToken)}`);
  logger.info(`[Boot]   catalogue move: ${config.catalogueMoveEnabled ? 'enabled' : 'off'}`);
  // Neither the secret nor the token is logged, not even in part.
  logger.info(
    `[Boot]   brand wallet secret: ${config.brandWalletSecret === null ? '(unset → no brand wallet)' : 'set'}`,
  );
  logger.info(
    `[Boot]   manager funding: ${
      config.managerFunding ? `${config.managerFunding.url}, with its token` : '(unset → funding is not set up)'
    }`,
  );
  logger.info("[Boot]   ingest: from each stream's stage, as the manager pushed it");
  const retired = retiredEnvKeysSet();
  if (retired.length > 0) {
    logger.warn(
      `[Boot] ${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} set but no longer read: each stream's OBS details come from its stage, and the catalogue is written through the catalogue stamp the manager pushes. Remove ${retired.length === 1 ? 'it' : 'them'} from the env file.`,
    );
  }
}

function createFeedGateway(): FeedGateway & CatalogueRestamper {
  if (config.feedGateway === 'fake') {
    logger.warn('[Boot] FEED_GATEWAY=fake: feed writes and thumbnail uploads stay in memory, nothing reaches Swarm');
    return new FakeFeedGateway();
  }
  return new BeeFeedGateway({ feedPrivateKey: config.feedPrivateKey, feedTopic: config.feedTopic });
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let sessionSweep: SessionSweep | undefined;
let catalogueMove: CatalogueMoveService | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    if (sessionSweep) {
      sessionSweep.stop();
      sessionSweep = undefined;
    }
    if (apiServer) {
      await apiServer.close();
      apiServer = undefined;
    }
    if (catalogueMove) {
      // After the slot it is on, so the move stays running and the next start resumes it.
      await catalogueMove.shutdown();
      catalogueMove = undefined;
    }
    if (database) {
      await database.close();
      database = undefined;
    }
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    const stack = getErrorStack(error);
    if (stack) logger.error(stack);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const feed = feedIdentityFrom(config.feedPrivateKey, config.feedTopic);
  logStartupConfig(feed.owner, feed.topicHex);

  database = new Database(config.databaseUrl);
  await database.migrate();

  // Right after the migrations, so a BRAND_WALLET_SECRET that does not open the stored wallet stops the start before
  // anything else runs. The first start with a secret creates the wallet.
  const brandWallet = await BrandWallet.start(new BrandWalletRepository(database.pool), config.brandWalletSecret);
  logger.info(`[Boot] brand wallet: ${brandWallet.address() ?? '(none)'}`);

  const userRepository = new PostgresUserRepository(database.pool);
  const sessionRepository = new PostgresSessionRepository(database.pool);
  const streamRepository = new StreamRepository(database.pool);
  const renditionRepository = new StreamRenditionRepository(database.pool);
  const feedWriteRepository = new FeedWriteRepository(database.pool);
  const auditLog = new PostgresAuditLog(database.pool);

  // Logs a line per row it repairs.
  await resetOrphanedPublishing(streamRepository, auditLog);

  const authService = new AuthService(
    userRepository,
    sessionRepository,
    new PostgresCredentialRepository(database.pool),
    auditLog,
  );
  // Prunes what has run out now, and once a day after that. There is no
  // sign-up and no seeded account: a database with no users refuses every
  // sign-in until the CLI has made one.
  sessionSweep = startSessionSweep(authService);

  if ((await authService.countUsers()) === 0) {
    logger.warn(
      '[Boot] no users exist yet. Every route but /api/health, /api/config and /api/internal refuses until one is created with: node dist/cli.js user:add <username>',
    );
  }

  const stageRepository = new StageRepository(database.pool);
  const streamService = new StreamService(streamRepository, stageRepository, feed, auditLog);
  const catalogueStampRepository = new CatalogueStampRepository(database.pool);
  const catalogueBatch = new CatalogueBatchService(catalogueStampRepository, feedWriteRepository, feed, auditLog, {
    stampRequired: config.feedGateway === 'bee',
  });
  const gateway = createFeedGateway();
  // Every catalogue write goes through this one mutex, and the last step of a catalogue move takes it as well, so
  // nothing is written between the move's catch-up and its switch to the new batch.
  const feedMutex = new Mutex();
  const publishService = new PublishService(
    streamRepository,
    renditionRepository,
    stageRepository,
    feedWriteRepository,
    gateway,
    catalogueBatch,
    feed,
    auditLog,
    feedMutex,
  );
  catalogueMove = new CatalogueMoveService(
    new CatalogueMoveRepository(database.pool),
    catalogueStampRepository,
    feedWriteRepository,
    streamRepository,
    gateway,
    feedMutex,
    feed,
    auditLog,
    { enabled: config.catalogueMoveEnabled },
  );
  // After the orphan reset, so the dry-run diff sees the repaired statuses.
  // Never fatal: this is a cross-check of the feed, and the API is fully
  // usable whatever it finds. With no catalogue batch designated yet it waits
  // for the manager's first designation, below.
  const feedBootCheck = new FeedBootCheckRunner(publishService);
  await feedBootCheck.run();
  // A move of the catalogue left running by the last process goes on where it stopped, in the background.
  await catalogueMove.resumeOnBoot();

  const ingestService = new IngestService(streamRepository, stageRepository, auditLog);
  const streamStateService = new StreamStateService(streamRepository, publishService, auditLog);
  const ladderService = new LadderService(streamRepository, renditionRepository, publishService, auditLog);
  const stageService = new StageService(stageRepository, catalogueStampRepository, auditLog, {
    registrarToken: config.internalApiToken,
  });
  stageService.onCatalogueStampStored(() => void feedBootCheck.catalogueStampStored());

  apiServer = startApiServer(
    {
      database,
      authService,
      streamService,
      streamStateService,
      ladderService,
      publishService,
      ingestService,
      stageService,
      catalogueBatch,
      catalogueMove,
      internalApiToken: config.internalApiToken,
      uploaderTokens: stageRepository,
      feed,
      viewerBaseUrl: config.viewerBaseUrl,
    },
    config.port,
    config.host,
  );
}

function stop() {
  setTimeout(() => process.exit(1), 1000).unref();
}

// gracefulShutdown catches every failure and exits with its status, so the signal need not await it.
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  stop();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  const stack = getErrorStack(reason);
  if (stack) logger.error(stack);
  stop();
});

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  const stack = getErrorStack(err);
  if (stack) logger.error(stack);
  stop();
});
