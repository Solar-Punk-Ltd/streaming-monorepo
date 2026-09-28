import {
  isOlderStageRecord,
  type CatalogueStampClearAnswer,
  type CatalogueStampRecord,
  type StageEngine,
  type StageRecord,
  type StageRetireAnswer,
  type StageStoreAnswer,
} from '@streaming-monorepo/contracts';

import {
  isDesignated,
  type CatalogueStampRow,
  type DesignatedCatalogueStamp,
  type StageRow,
  type StageSecretsRow,
} from '../types/index.js';
import { quoteForLog } from '../utils/logText.js';

import { describeActor, MANAGER } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { Logger } from './Logger.js';
import { Mutex } from './Mutex.js';
import type { RetireOutcome, StageWrite } from './StageRepository.js';

const logger = Logger.getInstance();

/** The slice of StageRepository the service needs; a fake stands in. */
export interface StageStore {
  list(): Promise<StageRow[]>;
  find(stageId: string): Promise<StageSecretsRow | null>;
  upsert(write: StageWrite): Promise<StageRow | null>;
  retire(stageId: string, observedAt: string): Promise<RetireOutcome<StageRow>>;
}

/** The slice of CatalogueStampRepository the service needs; a fake stands in. */
export interface CatalogueStampStore {
  get(): Promise<CatalogueStampRow | null>;
  upsert(record: CatalogueStampRecord): Promise<CatalogueStampRow | null>;
  clear(observedAt: string): Promise<RetireOutcome<CatalogueStampRow>>;
}

/** The engines the admin takes streams on in this round. An OvenMediaEngine stage is listed and takes none. */
export const SUPPORTED_STAGE_ENGINES: readonly StageEngine[] = ['srs'];

/** Whether a stage on this engine can take streams. */
export function stageTakesStreams(engine: StageEngine): boolean {
  return SUPPORTED_STAGE_ENGINES.includes(engine);
}

/** A stage record split the way migration 009 keeps it: the passphrase and the token apart from the rest. */
export function splitStageRecord(record: StageRecord): StageWrite {
  const { adminToken, ingest, ...rest } = record;
  const { srtPassphrase, ...ingestWithoutPassphrase } = ingest;
  return {
    record: { ...rest, ingest: ingestWithoutPassphrase },
    srtPassphrase,
    adminToken,
  };
}

/** `"Main stage" (stage 5f0c…)`: how a log line names a stage. The name is the manager's free text. */
export function describeStage(stage: { name: string; stageId: string }): string {
  return `${quoteForLog(stage.name)} (stage ${stage.stageId})`;
}

/** `ab12cd34…`: enough of a batch id to recognise it in a log. */
function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 8)}…`;
}

/** What a secret did between two records, said without the secret. */
function secretMove(before: string | null, after: string | null): 'set' | 'removed' | 'changed' | null {
  if (before === after) return null;
  if (before === null) return 'set';
  if (after === null) return 'removed';
  return 'changed';
}

/**
 * What a push changed that is worth an audit row: the owner, the ingest details, the passphrase, the uploader's token
 * and the manager. `details` goes into the row and `phrases` into the log line; neither holds the passphrase or the
 * token hash, only that they moved. Everything else (the name, the status, the stamp readings, readiness) moves all
 * the time and is only logged at debug.
 */
export interface StageChanges {
  details: Record<string, unknown>;
  phrases: string[];
}

export function stageChanges(previous: StageSecretsRow, write: StageWrite): StageChanges {
  const details: Record<string, unknown> = {};
  const phrases: string[] = [];
  const next = write.record;
  const before = previous.record;

  const compare = (field: string, label: string, from: unknown, to: unknown) => {
    if (from === to) return;
    details[field] = { from, to };
    phrases.push(`${label} ${String(from)} → ${String(to)}`);
  };

  compare('managerId', 'manager', previous.manager_id, next.managerId);
  compare('owner', 'owner', previous.owner, next.owner);
  compare('ingest.host', 'ingest host', before.ingest.host, next.ingest.host);
  compare('ingest.srtPort', 'SRT port', before.ingest.srtPort, next.ingest.srtPort);
  compare('ingest.rtmpPort', 'RTMP port', before.ingest.rtmpPort, next.ingest.rtmpPort);
  compare('ingest.rtmpPublic', 'RTMP public', before.ingest.rtmpPublic, next.ingest.rtmpPublic);

  const passphrase = secretMove(previous.srt_passphrase, write.srtPassphrase);
  if (passphrase) {
    details['ingest.srtPassphrase'] = passphrase;
    phrases.push(`passphrase ${passphrase}`);
  }

  const token = secretMove(previous.admin_token_sha256, write.adminToken?.sha256 ?? null);
  if (token) {
    details.adminToken = token;
    phrases.push(`uploader token ${token}`);
  }
  compare('adminTokenKind', 'token kind', previous.admin_token_kind, write.adminToken?.kind ?? null);

  return { details, phrases };
}

/**
 * The stages the manager pushes into the admin, and the brand's catalogue stamp. The manager is the only caller, on
 * the registrar token, so the service names it as the actor itself, the way the uploader's services do.
 *
 * A push arrives every 30 seconds per stage and almost always says what the last one said, so only what matters is
 * audited and logged at info: a stage registered, retired or brought back, and a change to its owner, its ingest
 * details or its token. Everything else is logged at debug.
 *
 * Every write runs under one mutex, so the read that decides what a push changed and the write that stores it are
 * not interleaved with another push. The admin is one process; the SQL holds the ordering rule as well.
 */
export class StageService {
  constructor(
    private readonly stages: StageStore,
    private readonly catalogue: CatalogueStampStore,
    private readonly audit: AuditLog,
    private readonly mutex: Mutex = new Mutex(),
  ) {}

  list(): Promise<StageRow[]> {
    return this.stages.list();
  }

  /** Stores the record unless the admin holds one observed later. Equal moments store: a repeat is not older. */
  store(record: StageRecord): Promise<StageStoreAnswer> {
    return this.mutex.run(async () => {
      const previous = await this.stages.find(record.stageId);
      if (previous && isOlderStageRecord(record, previous.record)) {
        this.keptNewer(record, `before the stored one (${previous.record.observedAt})`);
        return { stored: false };
      }

      const write = splitStageRecord(record);
      const written = await this.stages.upsert(write);
      if (!written) {
        // A stage never stored whose retirement was observed at or after this record, or, which the mutex rules
        // out in one process, a newer record stored in the meantime.
        this.keptNewer(record, 'at or before a retirement the admin holds for it');
        return { stored: false };
      }

      await this.recordStored(previous, write, written);
      return { stored: true };
    });
  }

  /**
   * Retires the stage as of `observedAt`, the moment the manager saw the deployment gone. Its row stays: streams and
   * old catalogue entries name its owner. Answers true only when this call retired a stored, active stage.
   */
  retire(stageId: string, observedAt: string): Promise<StageRetireAnswer> {
    return this.mutex.run(async () => {
      const who = describeActor(MANAGER);
      const result = await this.stages.retire(stageId, observedAt);
      switch (result.outcome) {
        case 'unknown':
          logger.info(
            `[Stages] ${who} retired stage ${stageId}, which was never registered here: a record observed at or before ${observedAt} will not register it`,
          );
          return { retired: false };
        case 'newer':
          logger.info(
            `[Stages] ${who} retired stage ${stageId} as of ${observedAt}, but holds a record observed after that: the stage stays`,
          );
          return { retired: false };
        case 'already':
          logger.debug(`[Stages] ${who} retired stage ${stageId}, which was retired already`);
          return { retired: false };
        case 'done': {
          const { row } = result;
          logger.info(`[Stages] ${who} retired stage ${describeStage({ name: row.name, stageId: row.stage_id })}`);
          await recordAudit(this.audit, {
            actor: MANAGER,
            action: 'stage.retire',
            details: { stageId: row.stage_id, name: row.name, observedAt },
          });
          return { retired: true };
        }
      }
    });
  }

  /** The designated catalogue stamp, or null when there is none or the manager cleared it. */
  async catalogueStamp(): Promise<DesignatedCatalogueStamp | null> {
    const row = await this.catalogue.get();
    return isDesignated(row) ? row : null;
  }

  /** Stores the catalogue stamp record unless the admin holds a record or a clear observed later. */
  storeCatalogueStamp(record: CatalogueStampRecord): Promise<StageStoreAnswer> {
    return this.mutex.run(async () => {
      const previous = await this.catalogue.get();
      if (previous && isOlderStageRecord(record, { observedAt: previous.observed_at.toISOString() })) {
        logger.debug(
          `[Stages] kept the catalogue stamp: the record pushed was observed at ${record.observedAt}, before the stored one (${previous.observed_at.toISOString()})`,
        );
        return { stored: false };
      }

      const written = await this.catalogue.upsert(record);
      if (!written) {
        logger.debug(
          `[Stages] kept the catalogue stamp: the record pushed was observed at ${record.observedAt}, at or before the clear the admin holds`,
        );
        return { stored: false };
      }

      await this.recordCatalogueStored(previous, record, written);
      return { stored: true };
    });
  }

  /**
   * Clears the designation as of `observedAt`, the moment the manager saw it gone: the admin then has no catalogue
   * batch. Answers true only when this call cleared a designation the admin held.
   */
  clearCatalogueStamp(observedAt: string): Promise<CatalogueStampClearAnswer> {
    return this.mutex.run(async () => {
      const who = describeActor(MANAGER);
      const result = await this.catalogue.clear(observedAt);
      switch (result.outcome) {
        case 'unknown':
          logger.info(
            `[Stages] ${who} cleared the catalogue stamp, which was never set here: a record observed at or before ${observedAt} will not set it`,
          );
          return { cleared: false };
        case 'newer':
          logger.info(
            `[Stages] ${who} cleared the catalogue stamp as of ${observedAt}, but holds a record observed after that: it stays`,
          );
          return { cleared: false };
        case 'already':
          logger.debug(`[Stages] ${who} cleared the catalogue stamp, which was cleared already`);
          return { cleared: false };
        case 'done': {
          const { record } = result.row;
          logger.info(
            `[Stages] ${who} cleared the catalogue stamp${
              record ? ` (batch ${shortBatch(record.batchId)} on ${quoteForLog(record.nodeName)})` : ''
            }`,
          );
          await recordAudit(this.audit, {
            actor: MANAGER,
            action: 'catalogue.stamp.clear',
            details: { batchId: record?.batchId ?? null, nodeName: record?.nodeName ?? null, observedAt },
          });
          return { cleared: true };
        }
      }
    });
  }

  private keptNewer(record: StageRecord, when: string): void {
    logger.debug(
      `[Stages] kept stage ${describeStage(record)}: the record pushed was observed at ${record.observedAt}, ${when}`,
    );
  }

  private async recordStored(previous: StageSecretsRow | null, write: StageWrite, written: StageRow): Promise<void> {
    const { record } = write;
    const stage = describeStage(record);
    const who = describeActor(MANAGER);

    if (!previous) {
      logger.info(
        `[Stages] ${who} registered stage ${stage}: ${record.kind} on ${record.engine}, owner ${record.owner}, ingest ${record.ingest.host}:${record.ingest.srtPort}`,
      );
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'stage.register',
        details: {
          stageId: record.stageId,
          managerId: record.managerId,
          name: record.name,
          kind: record.kind,
          engine: record.engine,
          owner: record.owner,
          ingest: { ...record.ingest, hasSrtPassphrase: write.srtPassphrase !== null },
          adminTokenKind: write.adminToken?.kind ?? null,
        },
      });
      return;
    }

    const changes = stageChanges(previous, write);
    const said = changes.phrases.length > 0 ? `: ${changes.phrases.join(', ')}` : '';

    if (previous.retired_observed_at !== null && written.retired_observed_at === null) {
      logger.info(`[Stages] ${who} brought back retired stage ${stage}${said}`);
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'stage.unretire',
        details: { stageId: record.stageId, name: record.name, changes: changes.details },
      });
      return;
    }

    if (changes.phrases.length > 0) {
      logger.info(`[Stages] ${who} changed stage ${stage}${said}`);
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'stage.change',
        details: { stageId: record.stageId, name: record.name, changes: changes.details },
      });
      return;
    }

    logger.debug(
      `[Stages] ${who} confirmed stage ${stage} as observed at ${record.observedAt}${
        written.retired_observed_at === null
          ? ''
          : ', which stays retired: the record was observed at or before the retirement'
      }`,
    );
  }

  private async recordCatalogueStored(
    previous: CatalogueStampRow | null,
    record: CatalogueStampRecord,
    written: CatalogueStampRow,
  ): Promise<void> {
    const who = describeActor(MANAGER);
    const where = `batch ${shortBatch(record.batchId)} on ${quoteForLog(record.nodeName)}`;

    if (written.cleared_observed_at !== null) {
      logger.debug(
        `[Stages] ${who} pushed the catalogue stamp, which stays cleared: it was observed at or before the clear`,
      );
      return;
    }

    if (!isDesignated(previous)) {
      logger.info(`[Stages] ${who} set the catalogue stamp: ${where}, depth ${record.depth}`);
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'catalogue.stamp.set',
        details: {
          batchId: record.batchId,
          nodeName: record.nodeName,
          immutable: record.immutable,
          depth: record.depth,
          designatedAt: record.designatedAt,
        },
      });
      return;
    }

    const before = previous.record;
    const changes: Record<string, unknown> = {};
    const phrases: string[] = [];
    if (before.batchId !== record.batchId) {
      changes.batchId = { from: before.batchId, to: record.batchId };
      phrases.push(`batch ${shortBatch(before.batchId)} → ${shortBatch(record.batchId)}`);
    }
    if (before.nodeName !== record.nodeName) {
      changes.nodeName = { from: before.nodeName, to: record.nodeName };
      phrases.push(`node ${quoteForLog(before.nodeName)} → ${quoteForLog(record.nodeName)}`);
    }
    if (before.beeApiUrl !== record.beeApiUrl) {
      changes.beeApiUrl = 'changed';
      phrases.push('Bee API address changed');
    }
    if (before.managerId !== record.managerId) {
      changes.managerId = { from: before.managerId, to: record.managerId };
      phrases.push(`manager ${before.managerId} → ${record.managerId}`);
    }

    if (phrases.length > 0) {
      logger.info(`[Stages] ${who} changed the catalogue stamp: ${phrases.join(', ')}`);
      await recordAudit(this.audit, { actor: MANAGER, action: 'catalogue.stamp.change', details: changes });
      return;
    }

    logger.debug(`[Stages] ${who} confirmed the catalogue stamp (${where}) as observed at ${record.observedAt}`);
  }
}
