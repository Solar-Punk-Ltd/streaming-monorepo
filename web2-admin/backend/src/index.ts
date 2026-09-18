import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/AuthService.js';
import { BeeFeedGateway } from './domain/BeeFeedGateway.js';
import { Database } from './domain/Database.js';
import { FakeFeedGateway } from './domain/FakeFeedGateway.js';
import type { FeedGateway } from './domain/FeedGateway.js';
import { feedIdentityFrom } from './domain/feedIdentity.js';
import { FeedWriteRepository } from './domain/FeedWriteRepository.js';
import { IngestService } from './domain/IngestService.js';
import { LadderService } from './domain/LadderService.js';
import { Logger } from './domain/Logger.js';
import { LoginRateLimiter } from './domain/LoginRateLimiter.js';
import { PublishService } from './domain/PublishService.js';
import { seedAdminUser } from './domain/seedAdmin.js';
import { SessionRepository } from './domain/SessionRepository.js';
import { StreamRenditionRepository } from './domain/StreamRenditionRepository.js';
import { StreamRepository } from './domain/StreamRepository.js';
import { StreamService } from './domain/StreamService.js';
import { StreamStateService } from './domain/StreamStateService.js';
import { UserRepository } from './domain/UserRepository.js';
import { config } from './utils/config.js';
import { getErrorMessage, getErrorStack } from './utils/errorUtils.js';

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
    `[Boot]   sessions: ttl ${config.sessionTtlHours}h, secure cookie ${config.cookieSecure}`,
  );
  logger.info(`[Boot]   feed gateway: ${config.feedGateway}`);
  logger.info(`[Boot]   bee: ${config.beeUrl}`);
  logger.info(`[Boot]   postage batch: ${redactSecret(config.postageBatchId)}`);
  logger.info(`[Boot]   feed key: ${redactSecret(config.feedPrivateKey)}`);
  logger.info(
    `[Boot]   feed: owner ${owner} topic "${config.feedTopic}" (${topicHex})`,
  );
  logger.info(
    `[Boot]   viewer: ${config.viewerBaseUrl || '(unset → no player links)'}`,
  );
  logger.info(
    `[Boot]   internal API token: ${redactSecret(config.internalApiToken)}`,
  );
  logger.info(
    `[Boot]   ingest: ${config.ingest.host} srt ${config.ingest.srtPort} rtmp ${config.ingest.rtmpPort}, passphrase ${
      config.ingest.srtPassphrase ? redactSecret(config.ingest.srtPassphrase) : '(unset)'
    }, key verified ${config.ingest.keyVerified}`,
  );
}

function createFeedGateway(): FeedGateway {
  if (config.feedGateway === 'fake') {
    logger.warn(
      '[Boot] FEED_GATEWAY=fake: feed writes and thumbnail uploads stay in memory, nothing reaches Swarm',
    );
    return new FakeFeedGateway();
  }
  return new BeeFeedGateway({
    beeUrl: config.beeUrl,
    postageBatchId: config.postageBatchId,
    feedPrivateKey: config.feedPrivateKey,
    feedTopic: config.feedTopic,
  });
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    if (apiServer) {
      await apiServer.close();
      apiServer = undefined;
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

  const userRepository = new UserRepository(database.pool);
  const sessionRepository = new SessionRepository(database.pool);
  const streamRepository = new StreamRepository(database.pool);
  const renditionRepository = new StreamRenditionRepository(database.pool);
  const feedWriteRepository = new FeedWriteRepository(database.pool);

  await seedAdminUser(userRepository, {
    username: config.seedAdminUsername,
    password: config.seedAdminPassword,
  });

  const orphans = await streamRepository.resetOrphanedPublishing();
  if (orphans.length > 0) {
    logger.warn(
      `[Boot] reset streams stuck in publishing: ${orphans
        .map((s) => s.topic)
        .join(', ')}`,
    );
  }

  const pruned = await sessionRepository.deleteExpired();
  if (pruned > 0) logger.info(`[Boot] pruned ${pruned} expired session(s)`);

  const authService = new AuthService(
    userRepository,
    sessionRepository,
    new LoginRateLimiter(),
    config.sessionTtlHours,
  );
  const streamService = new StreamService(streamRepository, feed);
  const publishService = new PublishService(
    streamRepository,
    renditionRepository,
    feedWriteRepository,
    createFeedGateway(),
    feed,
  );
  // After the orphan reset, so the dry-run diff sees the repaired statuses.
  // Never fatal: this is a cross-check of the feed, and the API is fully
  // usable whatever it finds.
  try {
    const check = await publishService.checkFeedOnBoot();
    logger.info(
      `[Boot] feed: last write recorded ${check.recorded ?? 'none'}, network head ${check.network ?? 'none'}${check.adopted ? ' (adopted)' : ''}`,
    );
  } catch (error) {
    logger.warn(`[Boot] feed check failed: ${getErrorMessage(error)}`);
  }

  const ingestService = new IngestService(streamRepository, config.ingest);
  const streamStateService = new StreamStateService(
    streamRepository,
    publishService,
  );
  const ladderService = new LadderService(
    streamRepository,
    renditionRepository,
    publishService,
  );

  apiServer = startApiServer(
    {
      database,
      authService,
      streamService,
      streamStateService,
      ladderService,
      publishService,
      ingestService,
      internalApiToken: config.internalApiToken,
      feed,
      cookie: { secure: config.cookieSecure },
      viewerBaseUrl: config.viewerBaseUrl,
    },
    config.port,
    config.host,
  );
}

function stop() {
  setTimeout(() => process.exit(1), 1000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
