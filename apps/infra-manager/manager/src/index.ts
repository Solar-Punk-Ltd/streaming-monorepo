import { createChequebookOperationsService } from './domain/chequebook/createChequebookOperationsService.js';
import { configuredBeeRpcEndpoint, getErrorStack, plurToBzz, getErrorMessage } from '@streaming-infra-manager/common';

import { ApiServerHandle, startApiServer } from './api/server.js';
import { AuthService } from './domain/auth/AuthService.js';
import { OpenStreams } from './domain/auth/OpenStreams.js';
import { PostgresCredentialRepository } from './domain/auth/PostgresCredentialRepository.js';
import { PostgresSessionRepository } from './domain/auth/PostgresSessionRepository.js';
import { PostgresUserRepository } from './domain/auth/PostgresUserRepository.js';
import { SessionSweep, startSessionSweep } from './domain/auth/sessionSweep.js';
import { StreamRevalidation, startStreamRevalidation } from './domain/auth/streamRevalidation.js';
import { ChequebookService } from './domain/ChequebookService.js';
import { ContainerControl } from './domain/ContainerControl.js';
import { ContainerRepository } from './domain/ContainerRepository.js';
import { Database } from './domain/Database.js';
import { DeployService } from './domain/DeployService.js';
import { DeploymentGroupRepository } from './domain/DeploymentGroupRepository.js';
import { DeploymentOrchestrator } from './domain/DeploymentOrchestrator.js';
import { EventBus } from './domain/EventBus.js';
import { Logger } from './domain/Logger.js';
import { MetricsCollector } from './domain/MetricsCollector.js';
import { ProfileRepository } from './domain/ProfileRepository.js';
import { ProfileService } from './domain/ProfileService.js';
import { ScriptRunner } from './domain/ScriptRunner.js';
import { IngestHealthService } from './domain/ingestHealth/IngestHealthService.js';
import { readManagerId } from './domain/stages/managerIdentity.js';
import { StagePublisher } from './domain/stages/StagePublisher.js';
import { StageRetirementRepository } from './domain/stages/StageRetirementRepository.js';
import { StageRecordBuilder } from './domain/stages/StageRecordBuilder.js';
import { StagePoolStrings } from './domain/stages/StagePoolStrings.js';
import { beeApiUrlFor, beePublisherUrlFor, StampService } from './domain/StampService.js';
import { localPublisherHost } from './domain/localHost.js';
import { CatalogueDesignationRepository } from './domain/stages/CatalogueDesignationRepository.js';
import { CatalogueDesignationService } from './domain/stages/CatalogueDesignationService.js';
import { CataloguePublisher } from './domain/stages/CataloguePublisher.js';
import { UploaderHealthService } from './domain/UploaderHealthService.js';
import { UploaderStartGate } from './domain/UploaderStartGate.js';
import { readBundledCommit } from './domain/versions/bundledCommit.js';
import { EngineConfigChecker } from './domain/engineConfig/engineConfigCheck.js';
import { EngineConfigService } from './domain/engineConfig/EngineConfigService.js';
import { DeploymentSettingsService } from './domain/settings/DeploymentSettingsService.js';
import { AdminTokenRotation } from './domain/adminLink/AdminTokenRotation.js';
import { AdminLinkTester } from './domain/adminLink/AdminLinkTester.js';
import { ManagerAdminLinkRepository } from './domain/adminLink/ManagerAdminLinkRepository.js';
import { ManagerAdminLinkService } from './domain/adminLink/ManagerAdminLinkService.js';
import { PostgresEngineConfigOperationRepository } from './domain/engineConfig/PostgresEngineConfigOperationRepository.js';
import { PostgresStackVersionRepository } from './domain/versions/PostgresStackVersionRepository.js';
import { PostgresBuildLedger } from './domain/versions/PostgresBuildLedger.js';
import { PostgresDeployAttemptRepository } from './domain/PostgresDeployAttemptRepository.js';
import { VerifiedDeployTargets } from './domain/ports/VerifiedDeployTargets.js';
import { FirewallInventoryExporter } from './domain/ports/FirewallInventoryExporter.js';
import { PostgresFirewallStateSource } from './domain/ports/PostgresFirewallStateSource.js';
import { ImmutableFirewallContractReader } from './domain/ports/ImmutableFirewallContractReader.js';
import { PostgresDeployTargetRepository } from './domain/ports/PostgresDeployTargetRepository.js';
import { TargetDocker } from './domain/ports/TargetDocker.js';
import { PortInventory } from './domain/ports/PortInventory.js';
import { refuseDeploymentsNamedAsKnownHostNetworkProjects } from './domain/ports/knownHostNetworkPorts.js';
import { PostgresPortReservationRepository } from './domain/ports/PostgresPortReservationRepository.js';
import { StackVersionService } from './domain/versions/StackVersionService.js';
import { ExecutionRootService } from './domain/versions/ExecutionRootService.js';
import { PostgresExecutionRootRepository } from './domain/versions/PostgresExecutionRootRepository.js';
import { executionsRootFor } from './domain/versions/stackPaths.js';
import { isLocalTarget } from './domain/ports/DeployTargets.js';
import { config } from './utils/config.js';
import { BUNDLED_STACK_ROOT } from './utils/envUtils.js';
import { resolveServerHost } from './utils/serverHost.js';

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

function logStartupConfig(): void {
  logger.info('[Boot] configuration:');
  logger.info(`[Boot]   listen: ${config.host}:${config.port}`);
  logger.info(`[Boot]   publicHost: ${config.publicHost || '(unset → localhost)'}`);
  logger.info(`[Boot]   serverHost (resolved): ${resolveServerHost()}`);
  logger.info(`[Boot]   logLevel: ${config.logLevel}`);
  logger.info(`[Boot]   chequebookFloor: ${plurToBzz(config.chequebookFloorPlur)} BZZ`);
  logger.info(`[Boot]   database: ${redactDatabaseUrl(config.databaseUrl)}`);
  // The host alone, never the URL: an endpoint can carry an API key, and this
  // line goes to the log.
  logger.info(
    `[Boot]   bee RPC endpoint: ${configuredBeeRpcEndpoint(config.beeRpcEndpoint).host ?? '(unset → the stack’s own)'}`,
  );
  logger.info(`[Boot]   bundled stack: ${BUNDLED_STACK_ROOT}`);
  logger.info(`[Boot]   stack versions root: ${config.stackVersionsRoot}`);
}

let apiServer: ApiServerHandle | undefined;
let database: Database | undefined;
let metricsCollector: MetricsCollector | undefined;
let sessionSweep: SessionSweep | undefined;
let streamRevalidation: StreamRevalidation | undefined;
let chequebookOperations: ReturnType<typeof createChequebookOperationsService> | undefined;
let stagePublisher: StagePublisher | undefined;
let cataloguePublisher: CataloguePublisher | undefined;
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
    if (streamRevalidation) {
      streamRevalidation.stop();
      streamRevalidation = undefined;
    }
    if (metricsCollector) {
      metricsCollector.stop();
      metricsCollector = undefined;
    }
    if (stagePublisher) {
      stagePublisher.stop();
      stagePublisher = undefined;
    }
    if (cataloguePublisher) {
      cataloguePublisher.stop();
      cataloguePublisher = undefined;
    }
    const [apiClosed, transferCleanup] = await Promise.allSettled([
      apiServer?.close(),
      chequebookOperations?.shutdown(),
    ]);
    if (transferCleanup.status === 'rejected') throw new Error('Transfer transport cleanup could not be verified.');
    for (const outcome of transferCleanup.value ?? []) {
      if (outcome.state === 'unverified')
        logger.warn(
          `[Shutdown] transfer transport ${outcome.leaseId}: ${outcome.reason} (${outcome.remaining.join(', ')})`,
        );
    }
    if (apiClosed.status === 'rejected') throw new Error('API shutdown could not be verified.');
    apiServer = undefined;
    if (database) {
      await database.close();
      database = undefined;
    }
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    const stack = getErrorStack(error);
    if (stack) {
      logger.error(stack);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Before the first line, so nothing below the configured level is written.
  logger.setLevel(config.logLevel);
  logStartupConfig();

  database = new Database(config.databaseUrl);
  await database.migrate();

  const eventBus = new EventBus();
  const openStreams = new OpenStreams();
  const authService = new AuthService(
    new PostgresUserRepository(database.pool),
    new PostgresSessionRepository(database.pool),
    new PostgresCredentialRepository(database.pool),
    openStreams,
  );
  sessionSweep = startSessionSweep(authService);
  streamRevalidation = startStreamRevalidation(authService);

  if ((await authService.countUsers()) === 0) {
    logger.warn(
      '[Boot] no users exist yet. Every route but /health refuses until one is created with: node dist/cli.js user:add <username>',
    );
  }

  const scriptRunner = new ScriptRunner();
  const stackVersionRepository = new PostgresStackVersionRepository(database.pool);
  // Ahead of the profiles: the versions are what deployments run on.
  const containerControl = new ContainerControl(eventBus);
  // Which build each deployment runs on. The claim writes it, the success
  // hook and boot observe the containers, and prune keeps what they mount.
  const buildLedger = new PostgresBuildLedger(database.pool, containerControl, config.stackVersionsRoot);
  // The private copy each deployment runs its scripts from, so a build is
  // never written into by a deploy. Under the versions root, which the api
  // container sees at the same absolute path the host does.
  const executionsParent = executionsRootFor(config.stackVersionsRoot);
  const executionRoots = new ExecutionRootService(
    new PostgresExecutionRootRepository(database.pool, executionsParent),
    executionsParent,
    async (target) => (isLocalTarget(target.alias) ? containerControl.executionMountReader() : null),
  );
  const stackVersionService = new StackVersionService(
    stackVersionRepository,
    scriptRunner,
    eventBus,
    config.stackVersionsRoot,
    buildLedger,
    BUNDLED_STACK_ROOT,
    undefined,
    config.stackSources,
  );

  const interruptedBuilds = await stackVersionService.failInterruptedBuilds();
  if (interruptedBuilds.length > 0) {
    logger.warn(`[Boot] stack version builds interrupted by a restart: ${interruptedBuilds.join(', ')}`);
  }

  const profileRepository = new ProfileRepository(database.pool);
  refuseDeploymentsNamedAsKnownHostNetworkProjects(
    (await profileRepository.list()).map((profile) => profile.name),
    config.knownHostNetworkPorts,
  );
  const containerRepository = new ContainerRepository(database.pool);

  // What a gone manager left: attempts whose builder is gone go, containers
  // are asked what they mount so a crashed job's reference can resolve, and
  // then builds nothing protects go. A daemon that does not answer keeps
  // everything, which is the safe side.
  try {
    await stackVersionService.cleanInterruptedAttempts({
      containerExists: (name) => containerControl.containerExists(name),
    });
    await buildLedger.observeAll();
  } catch (err) {
    logger.warn(`[Boot] the builds were not reconciled: ${getErrorMessage(err)}. Nothing was deleted.`);
  }
  // After the containers were observed, so a bundled build one still mounts
  // has its reference before anything prunes.
  try {
    await stackVersionService.syncBundled(BUNDLED_STACK_ROOT, readBundledCommit(BUNDLED_STACK_ROOT));
  } catch (err) {
    logger.warn(`[Boot] the bundled version was not synced: ${getErrorMessage(err)}`);
  }
  // Before the prune: a copy taken back here releases its hold on a build, and
  // a build nothing holds any more is what the prune is looking for.
  try {
    await executionRoots.reclaimInterrupted();
  } catch (err) {
    logger.warn(`[Boot] the execution copies were not reclaimed: ${getErrorMessage(err)}. Nothing was deleted.`);
  }
  try {
    await stackVersionService.pruneAll();
  } catch (err) {
    logger.warn(`[Boot] the builds were not pruned: ${getErrorMessage(err)}. Nothing was deleted.`);
  }
  // The stack commit this manager pins, built here on the host. A build that
  // cannot start or cannot finish leaves a failed version row the Versions page
  // shows and an Update button retries, never an api that refuses to start.
  try {
    await stackVersionService.ensureBundledBuild();
  } catch (err) {
    logger.warn(`[Boot] the pinned stack commit was not built: ${getErrorMessage(err)}. The api starts either way.`);
  }

  const deploymentGroupRepository = new DeploymentGroupRepository(database.pool);
  // Ahead of the orchestrator and ProfileService: the uploader gate asks it
  // whether a batch is still usable, and a ladder's readiness depends on what
  // each rung's bee node says about its own.
  const stampService = new StampService(profileRepository, containerRepository, eventBus);
  // A drained chequebook is the stamp failure one layer down: peers stop
  // forwarding what the node cannot pay them for. The gate asks about both.
  const chequebookService = new ChequebookService(profileRepository, config.chequebookFloorPlur, eventBus);
  // What an uploader says about itself, which includes a Bee node it
  // may still be waiting for. It reads the version's port table for the API
  // port of the deployment's own slot.
  const uploaderHealthService = new UploaderHealthService(
    profileRepository,
    containerRepository,
    stackVersionRepository,
  );
  chequebookOperations = createChequebookOperationsService(database.pool, {
    rpcEndpoints: process.env.CHEQUEBOOK_RPC_ENDPOINTS,
    dockerTransports: process.env.CHEQUEBOOK_DOCKER_TRANSPORTS,
    dockerHost: process.env.DOCKER_HOST,
  });
  chequebookOperations.start();
  // The project guard and the daemon lock: every deploy attempt holds its
  // project until its containers prove it over, and shared-tag builds wait
  // for each other on the daemon.
  const deployAttempts = new PostgresDeployAttemptRepository(database.pool);
  const portReservations = new PostgresPortReservationRepository(database.pool);
  const targetDocker = new TargetDocker(containerControl);
  // SRS's own count of the packets its SRT publishers lost and dropped, read
  // out of the engine's log on whichever host the deployment runs on.
  const ingestHealthService = new IngestHealthService(profileRepository, targetDocker);
  const deployTargets = new VerifiedDeployTargets(new PostgresDeployTargetRepository(database.pool), targetDocker);
  try {
    await deployTargets.verify('localhost');
  } catch {
    logger.warn('[Boot] The local Docker target could not be verified. Port allocation stays blocked for it.');
  }
  const portInventory = new PortInventory(
    profileRepository,
    stackVersionRepository,
    portReservations,
    deployTargets,
    targetDocker,
  );
  const firewallInventory = new FirewallInventoryExporter(
    new PostgresFirewallStateSource(database.pool),
    targetDocker,
    new ImmutableFirewallContractReader(),
  );
  try {
    await portInventory.seed();
  } catch (err) {
    logger.warn(`[Boot] The reservation inventory remains incomplete: ${getErrorMessage(err)}`);
  }
  // The rollouts of config files, which the orchestrator closes when an
  // operator acts on the deployment and the config service acts through.
  const engineConfigOperations = new PostgresEngineConfigOperationRepository(database.pool, config.stackVersionsRoot);
  const orchestrator = new DeploymentOrchestrator(
    profileRepository,
    containerRepository,
    scriptRunner,
    eventBus,
    deploymentGroupRepository,
    stackVersionRepository,
    buildLedger,
    deployAttempts,
    targetDocker,
    engineConfigOperations,
    new UploaderStartGate(stampService, chequebookService),
    deployTargets,
    portReservations,
    targetDocker,
    portInventory,
    executionRoots,
    config.beeRpcEndpoint,
  );
  try {
    const judged = await orchestrator.reconcileAttempts();
    if (judged.released.length > 0 || judged.blocked.length > 0) {
      logger.info(
        `[Boot] deploy attempts judged: released ${judged.released.join(', ') || 'none'}, blocked ${judged.blocked.join(', ') || 'none'}`,
      );
    }
  } catch (err) {
    logger.warn(`[Boot] the deploy attempts were not judged: ${getErrorMessage(err)}. They stay as they are.`);
  }
  // A deployment the manager was restarted in the middle of, judged by the
  // containers its services have now. Here rather than before the orchestrator
  // exists, because the judgement is the daemon's to make, and before the
  // config rollouts are reconciled below, which read what these rows say.
  try {
    const settled = await orchestrator.reconcileOrphanedTransitions();
    if (settled.length > 0) {
      logger.warn(
        `[Boot] deployments the restart interrupted, judged by their containers: ${settled
          .map((profile) => `${profile.name} is ${profile.status}`)
          .join(', ')}`,
      );
    }
  } catch (err) {
    logger.warn(`[Boot] the interrupted deployments were not judged: ${getErrorMessage(err)}. They stay as they are.`);
  }
  const managerAdminLink = new ManagerAdminLinkRepository(database.pool);
  // A deploy gives an uploader linked to this admin a token of its own. adminLink/ownAdminToken.ts.
  orchestrator.setManagerAdminLink(managerAdminLink);
  const profileService = new ProfileService(
    profileRepository,
    containerRepository,
    orchestrator,
    eventBus,
    deploymentGroupRepository,
    stackVersionRepository,
    portInventory,
    (profile, stampId) => stampService.stampHealthFor(profile, stampId),
    (url) => stampService.publishUrlStateFor(url),
    portReservations,
    undefined,
    config.beeRpcEndpoint,
    managerAdminLink,
  );
  const deployService = new DeployService(profileService, orchestrator);

  // The stage records every uploader deployment pushes into the web2 admin its
  // link names, under the manager's own id. docs/features/stages.md.
  const managerId = await readManagerId(database.pool);
  logger.info(`[Boot]   manager id: ${managerId}`);
  const stageBuilder = new StageRecordBuilder(
    {
      nextEnvFor: (profile) => orchestrator.nextEnvFor(profile),
      listProfiles: () => profileRepository.list(),
      stampHealthFor: (profile, stampId) => stampService.stampHealthFor(profile, stampId),
      chequebookSummary: (name) => chequebookService.summary(name),
      uploaderHealth: (name) => uploaderHealthService.read(name),
    },
    // Never the localhost fallback the component links use: a stage with no public address is not pushed.
    { managerId, publicHost: config.publicHost },
  );
  stagePublisher = new StagePublisher({
    profiles: {
      list: () => profileService.list(),
      find: async (name) => {
        const row = await profileRepository.findByName(name);
        return row ? containerRepository.withContainers(row) : null;
      },
    },
    builder: stageBuilder,
    link: managerAdminLink,
    retirements: new StageRetirementRepository(database.pool),
    events: eventBus,
  });
  const publisher = stagePublisher;
  orchestrator.setBeforeUploaderStart((profile) => publisher.beforeUploaderStart(profile));
  publisher.start();

  // The brand's catalogue node and its pinned batch, whose record goes to the same link. docs/features/stages.md.
  const catalogueDesignation = new CatalogueDesignationRepository(database.pool);
  cataloguePublisher = new CataloguePublisher({
    designation: catalogueDesignation,
    profiles: profileRepository,
    reading: (profile, batchId) => stampService.batchReadingFor(profile, batchId),
    beeApiUrl: beeApiUrlFor,
    link: managerAdminLink,
    events: eventBus,
    managerId,
  });
  const catalogue = cataloguePublisher;
  const catalogueService = new CatalogueDesignationService({
    store: catalogueDesignation,
    profiles: profileRepository,
    groupKindOf: async (id) => (await deploymentGroupRepository.findById(id))?.kind ?? null,
    heldBatch: (name, batchId) => stampService.heldBatch(name, batchId),
    status: () => catalogue.status(),
    changed: () => void catalogue.pushNow(),
    nodeUrls: async (profile) => [beeApiUrlFor(profile), beePublisherUrlFor(profile, await localPublisherHost())],
  });
  profileService.setPoolStringGuard((beePublishers) => catalogueService.segmentBatchProblem(beePublishers));
  // An ABR stage deploys with its pool's current batches, and a batch set on a rung reaches its stages' stored copy.
  const stagePoolStrings = new StagePoolStrings({
    profiles: profileRepository,
    groups: deploymentGroupRepository,
    publisherHost: localPublisherHost,
    guard: (beePublishers) => catalogueService.segmentBatchProblem(beePublishers),
    changed: async (profile) =>
      eventBus.publish({ type: 'profile.changed', profile: await containerRepository.withContainers(profile) }),
  });
  orchestrator.setPoolStrings((profile) => stagePoolStrings.withCurrentBatches(profile));
  stampService.setAfterStampSet((name) => stagePoolStrings.refreshStagesOf(name));
  // The pinned batch's node, and while a move is pending the node of the batch it moved from.
  orchestrator.setRemovalGuard((name) => catalogueService.assertRemovable(name));
  catalogue.start();

  const engineConfigService = new EngineConfigService(
    profileRepository,
    containerRepository,
    orchestrator,
    stackVersionRepository,
    containerControl,
    new EngineConfigChecker(),
    eventBus,
    engineConfigOperations,
  );
  // After the interrupted deployments are judged above, which is what an
  // interrupted apply's row has been through by now, and before the API
  // answers, so no card sees a rollout a gone manager left open as though it
  // were still under way.
  await engineConfigService.reconcileAtBoot();

  metricsCollector = new MetricsCollector();
  metricsCollector.setManagedProjectsProvider(async () => new Set((await profileRepository.list()).map((p) => p.name)));

  apiServer = startApiServer(
    {
      database,
      authService,
      openStreams,
      profileService,
      deployService,
      stampService,
      chequebookService,
      chequebookOperations,
      uploaderHealthService,
      ingestHealthService,
      containerControl,
      engineConfigService,
      deploymentSettingsService: new DeploymentSettingsService(
        profileRepository,
        containerRepository,
        orchestrator,
        stackVersionRepository,
        managerAdminLink,
      ),
      managerAdminLinkService: new ManagerAdminLinkService(managerAdminLink),
      adminLinkTester: new AdminLinkTester(managerAdminLink, profileRepository, orchestrator, undefined, publisher),
      adminTokenRotation: new AdminTokenRotation(
        profileRepository,
        orchestrator,
        managerAdminLink,
        containerRepository,
        eventBus,
      ),
      stagePublisher: publisher,
      catalogueService,
      stackVersionService,
      orchestrator,
      deployTargets,
      portInventory,
      firewallInventory,
      portReservations,
      eventBus,
      metricsCollector,
      beeRpcEndpoint: config.beeRpcEndpoint,
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
  if (stack) {
    logger.error(stack);
  }

  stop();
});

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  const stack = getErrorStack(err);
  if (stack) {
    logger.error(stack);
  }

  stop();
});
