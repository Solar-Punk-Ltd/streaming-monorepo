import { createHash } from 'node:crypto';

import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  addressOfStreamKey,
  type ChequebookHealth,
  chequebookHealthFromPayload,
  type ChequebookSummary,
  engineForComponents,
  type EngineName,
  getErrorMessage,
  isLoopbackIngestHost,
  isStageKind,
  NO_PUBLIC_INGEST_HOST,
  ownsBeeNode,
  parseBeePublishers,
  plurToBzzExact,
  PUBLIC_PORT_ROLES,
  readinessInputOf,
  resolvedIngestHost,
  rungOrder,
  SRS_SERVICE,
  stageReadinessOf,
  type StampHealth,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';
import {
  STAGE_RECORD_SCHEMA_VERSION,
  type StageChequebook,
  type StageRecord,
  stageRecordSchema,
  type StageRung,
  type StageStamp,
} from '@streaming-monorepo/contracts';

import type { Profile, ProfileWithContainers } from '../../types/index.js';
import type { NextDeployEnv } from '../DeploymentOrchestrator.js';

/** The SRT and RTMP ports in every version's port table, which `deploy.sh` shifts by the slot. */
const SRT_PORT_KEY = 'SRS_SRT_PORT';
const RTMP_PORT_KEY = 'SRS_RTMP_PORT';
/** Where an OME stage takes SRT, from the same slot of the table, see `OME_PORT_SOURCES`. */
const OME_SRT_PORT_KEY = 'OME_SRT_PORT';
const SRT_PASSPHRASE_KEY = 'SRT_PASSPHRASE';
const STREAM_KEY_KEY = 'STREAM_KEY';

/**
 * The one rung of a stage that publishes a single rendition. A stage with a node pool names each rung after the
 * quality it carries; a streamer carries its source as it comes.
 */
export const SINGLE_RUNG_NAME = 'source';

/** What the builder reads, each a narrow door so a test hands in its own. */
export interface StageReadings {
  /** The environment the deployment's next deploy gives its containers, `DeploymentOrchestrator.nextEnvFor`. */
  nextEnvFor(profile: Profile): Promise<Pick<NextDeployEnv, 'env' | 'version' | 'ownAdminToken'>>;
  /** Every deployment, to find the node that stamps with a pool's batch. */
  listProfiles(): Promise<Profile[]>;
  /** `StampService.stampHealthFor`, which never throws. */
  stampHealthFor(profile: Profile, stampId: string): Promise<StampHealth>;
  /** `ChequebookService.summary` of one node deployment. */
  chequebookSummary(name: string): Promise<ChequebookSummary>;
  /** `UploaderHealthService.read`. */
  uploaderHealth(name: string): Promise<UploaderHealthReading>;
}

export interface StageRecordBuilderOptions {
  /** The manager's own id, migration 045. */
  managerId: string;
  /** The manager's public address, `PUBLIC_HOST`, for a deployment on its own host, or empty when it has none. */
  publicHost: string;
  now?: () => Date;
}

/** The record for one deployment, and the address its uploader reports to, or why there is none. */
export type BuiltStage =
  | { ok: true; record: StageRecord; adminApiUrl: string }
  | { ok: false; problem: string; stageId: string | null };

/** What a stage's own node said, for a stage that runs one. */
interface OwnNodeReadings {
  stamp: StampHealth | undefined;
  chequebook: ChequebookHealth | null;
  summary: ChequebookSummary | null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function batchIdOf(stampId: string): string {
  return stampId.replace(/^0x/i, '').toLowerCase();
}

function portOf(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Whether the port policy opens this port variable to the internet. */
function portIsPublic(portVar: string): boolean {
  return PUBLIC_PORT_ROLES.some(
    (role) => role.portVar === portVar || (role.aliases ?? []).some((alias) => alias.portVar === portVar),
  );
}

/**
 * Whether broadcasters reach the stage over RTMP: only where SRS runs and the
 * port policy opens its RTMP port. The policy opens none, so this is false on
 * every stage and SRT is the ingest broadcasters use. OvenMediaEngine takes SRT
 * alone.
 */
function takesPublicRtmp(engine: EngineName): boolean {
  return engine === SRS_SERVICE && portIsPublic(RTMP_PORT_KEY);
}

function stageStampOf(stampId: string, health: StampHealth | null): StageStamp | null {
  if (!health) return null;
  return {
    batchId: batchIdOf(stampId),
    state: health.state,
    ttlSeconds: health.ttl,
    fillRatio: health.fillRatio,
    immutable: health.immutable,
  };
}

function stageChequebookOf(summary: ChequebookSummary | null): StageChequebook | null {
  if (!summary) return null;
  const available = chequebookHealthFromPayload(summary.health).availablePlur;
  return {
    health: summary.health.state,
    availableBzz: available === null || available < 0n ? null : plurToBzzExact(available),
  };
}

/** Where a record breaks the schema, by field path only, so no value reaches a log line. */
function schemaProblem(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const paths = [...new Set(issues.map((issue) => issue.path.map(String).join('.') || '(record)'))];
  return `The record does not pass the stage record schema at ${paths.join(', ')}.`;
}

/**
 * The stage record of one deployment that runs a stream uploader, exactly as `stageRecordSchema` in the contracts
 * package takes it, from what the manager reads at that moment.
 *
 * The owner is derived from the stream key the next deploy gives the uploader, and the key goes nowhere else. The
 * admin token is carried by its sha256 alone. No signing key, wallet key, RPC endpoint, token or rung node address
 * has a field on the record, and the schema check before it leaves drops anything it does not name.
 */
export class StageRecordBuilder {
  private readonly now: () => Date;

  constructor(
    private readonly readings: StageReadings,
    private readonly options: StageRecordBuilderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * @param readAt when the caller read the deployment's row, which is the moment the record says it was observed.
   *   Before the slower readings of nodes and the uploader, so a record read before the deployment was removed can
   *   never carry a later moment than its retirement. Left out, it is now.
   */
  async build(profile: ProfileWithContainers, readAt: Date = this.now()): Promise<BuiltStage> {
    const stageId = profile.instance_id;
    if (!isStageKind(profile.kind)) {
      return { ok: false, problem: `A ${profile.kind} deployment runs no stream uploader.`, stageId: null };
    }
    const observedAt = readAt.toISOString();

    let next: Pick<NextDeployEnv, 'env' | 'version' | 'ownAdminToken'>;
    try {
      next = await this.readings.nextEnvFor(profile);
    } catch (err) {
      return {
        ok: false,
        problem: `The environment of the next deploy could not be worked out: ${getErrorMessage(err)}`,
        stageId,
      };
    }
    const { env } = next;

    const owner = addressOfStreamKey(env[STREAM_KEY_KEY] ?? '');
    if (owner === null) {
      return {
        ok: false,
        problem: 'The next deploy gives the uploader no stream key, so the stage has no owner to sign as.',
        stageId,
      };
    }

    const engine = engineForComponents(profile.components);
    const srtPort = portOf(engine === 'ome' ? (env[OME_SRT_PORT_KEY] ?? env[SRT_PORT_KEY]) : env[SRT_PORT_KEY]);
    const rtmpPort = portOf(env[RTMP_PORT_KEY]);
    if (srtPort === null || rtmpPort === null) {
      return {
        ok: false,
        problem: `The version's port table gives this deployment no ${srtPort === null ? 'SRT' : 'RTMP'} port.`,
        stageId,
      };
    }

    const ingestHost = resolvedIngestHost(profile, this.options.publicHost);
    if (isLoopbackIngestHost(ingestHost)) return { ok: false, problem: NO_PUBLIC_INGEST_HOST, stageId };

    const ownReadings = this.ownNodeReadings(profile);
    const [rungs, own, uploader] = await Promise.all([
      this.rungsOf(profile, ownReadings),
      ownReadings,
      this.uploaderOf(profile.name),
    ]);

    const token = env[ADMIN_API_TOKEN_KEY] ?? '';
    const record = {
      schemaVersion: STAGE_RECORD_SCHEMA_VERSION,
      stageId,
      managerId: this.options.managerId,
      name: profile.name,
      kind: profile.kind,
      engine,
      stackVersion: next.version.name ?? null,
      status: profile.status,
      observedAt,
      ingest: {
        host: ingestHost,
        srtPort,
        rtmpPort,
        rtmpPublic: takesPublicRtmp(engine),
        srtPassphrase: env[SRT_PASSPHRASE_KEY] || null,
      },
      owner,
      rungs,
      uploader: uploader && { state: uploader.state, reasons: [...uploader.reasons] },
      readiness: stageReadinessOf(
        readinessInputOf(profile, own.stamp, own.chequebook, uploader ? { uploaderHealth: uploader } : {}),
      ),
      adminToken:
        token === ''
          ? null
          : // By where the token came from, never by comparing it with the link's: only the token the manager
            // generated for this deployment is its own. A copied or typed token, or a version's, is shared, which the
            // admin refuses and reports as one to rotate, so an old copy of the registrar token never becomes a
            // stage's own after the link's token changes.
            { sha256: sha256Hex(token), kind: next.ownAdminToken ? 'own' : 'shared' },
    };

    const parsed = stageRecordSchema.safeParse(record);
    if (!parsed.success) return { ok: false, problem: schemaProblem(parsed.error.issues), stageId };
    return { ok: true, record: parsed.data, adminApiUrl: env[ADMIN_API_URL_KEY] ?? '' };
  }

  /**
   * The rungs a stage publishes through. A pool's rungs come from its `BEE_PUBLISHERS`, lowest first, each read on
   * the deployment of this manager that stamps with that rung's batch; a rung whose node this manager does not run
   * has no reading. A stage with a node of its own has one rung, read there. Neither carries a node address.
   */
  private async rungsOf(profile: Profile, ownReadings: Promise<OwnNodeReadings>): Promise<StageRung[]> {
    const entries = profile.bee_publishers ? parseBeePublishers(profile.bee_publishers) : null;
    if (entries && entries.length > 0) {
      const nodes = (await this.readings.listProfiles().catch(() => [] as Profile[])).filter(
        (candidate) => ownsBeeNode(candidate) && candidate.stamp_id,
      );
      const sorted = [...entries].sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung));
      return Promise.all(
        sorted.map(async (entry) => {
          const node = nodes.find((candidate) => batchIdOf(candidate.stamp_id ?? '') === entry.batchId);
          if (!node) return { name: entry.rung, stamp: null, chequebook: null };
          const [health, summary] = await Promise.all([
            this.readings.stampHealthFor(node, entry.batchId).catch(() => null),
            this.readings.chequebookSummary(node.name).catch(() => null),
          ]);
          return {
            name: entry.rung,
            stamp: stageStampOf(entry.batchId, health),
            chequebook: stageChequebookOf(summary),
          };
        }),
      );
    }
    if (!ownsBeeNode(profile)) return [{ name: SINGLE_RUNG_NAME, stamp: null, chequebook: null }];
    const own = await ownReadings;
    return [
      {
        name: SINGLE_RUNG_NAME,
        stamp: profile.stamp_id ? stageStampOf(profile.stamp_id, own.stamp ?? null) : null,
        chequebook: stageChequebookOf(own.summary),
      },
    ];
  }

  /** The deployment's own node's batch and chequebook, for a stage that runs one, which its readiness reads. */
  private async ownNodeReadings(profile: Profile): Promise<OwnNodeReadings> {
    if (!ownsBeeNode(profile)) return { stamp: undefined, chequebook: null, summary: null };
    const [stamp, summary] = await Promise.all([
      profile.stamp_id
        ? this.readings.stampHealthFor(profile, profile.stamp_id).catch(() => undefined)
        : Promise.resolve(undefined),
      this.readings.chequebookSummary(profile.name).catch(() => null),
    ]);
    return { stamp, summary, chequebook: summary ? chequebookHealthFromPayload(summary.health) : null };
  }

  /** The uploader's own reading, or null when it could not be read at all. */
  private async uploaderOf(name: string): Promise<UploaderHealthReading | null> {
    try {
      return await this.readings.uploaderHealth(name);
    } catch {
      return null;
    }
  }
}
