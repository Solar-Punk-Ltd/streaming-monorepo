import {
  isOlderStageRecord,
  type CatalogueStampRecord,
  type StageRecord,
  type StageRetireAnswer,
  type StageStoreAnswer,
} from '@streaming-monorepo/contracts';

import type { CatalogueStampRow, StageRow, StageSecretsRow } from '../types/index.js';
import { quoteForLog } from '../utils/logText.js';

import { describeActor, MANAGER } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { Logger } from './Logger.js';
import { Mutex } from './Mutex.js';
import type { StageWrite } from './StageRepository.js';

const logger = Logger.getInstance();

/** The slice of StageRepository the service needs; a fake stands in. */
export interface StageStore {
  list(): Promise<StageRow[]>;
  find(stageId: string): Promise<StageSecretsRow | null>;
  upsert(write: StageWrite): Promise<StageRow | null>;
  retire(stageId: string): Promise<StageRow | null>;
}

/** The slice of CatalogueStampRepository the service needs; a fake stands in. */
export interface CatalogueStampStore {
  get(): Promise<CatalogueStampRow | null>;
  upsert(record: CatalogueStampRecord): Promise<CatalogueStampRow | null>;
  clear(): Promise<CatalogueStampRow | null>;
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
        // Only when another writer got in between, which the mutex rules out in one process.
        this.keptNewer(record, 'before one stored in the meantime');
        return { stored: false };
      }

      await this.recordStored(previous, write, written);
      return { stored: true };
    });
  }

  /** Retires the stage. Its row stays: streams and old catalogue entries name its owner. */
  retire(stageId: string): Promise<StageRetireAnswer> {
    return this.mutex.run(async () => {
      const retired = await this.stages.retire(stageId);
      if (!retired) {
        logger.debug(
          `[Stages] ${describeActor(MANAGER)} retired stage ${stageId}, which is unknown or retired already`,
        );
        return { retired: false };
      }

      const stage = { name: retired.name, stageId: retired.stage_id };
      logger.info(`[Stages] ${describeActor(MANAGER)} retired stage ${describeStage(stage)}`);
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'stage.retire',
        details: { stageId: retired.stage_id, name: retired.name },
      });
      return { retired: true };
    });
  }

  /** The designated catalogue stamp, or null when there is none or the manager cleared it. */
  async catalogueStamp(): Promise<CatalogueStampRow | null> {
    const row = await this.catalogue.get();
    return row && row.cleared_at === null ? row : null;
  }

  /** Stores the catalogue stamp record unless the admin holds one observed later. */
  storeCatalogueStamp(record: CatalogueStampRecord): Promise<StageStoreAnswer> {
    return this.mutex.run(async () => {
      const previous = await this.catalogue.get();
      if (previous && isOlderStageRecord(record, previous.record)) {
        logger.debug(
          `[Stages] kept the catalogue stamp: the record pushed was observed at ${record.observedAt}, before the stored one (${previous.record.observedAt})`,
        );
        return { stored: false };
      }

      const written = await this.catalogue.upsert(record);
      if (!written) {
        logger.debug(`[Stages] kept the catalogue stamp: a newer record was stored first`);
        return { stored: false };
      }

      await this.recordCatalogueStored(previous, written);
      return { stored: true };
    });
  }

  /** Clears the designation: the admin then has no catalogue batch. */
  clearCatalogueStamp(): Promise<{ cleared: boolean }> {
    return this.mutex.run(async () => {
      const cleared = await this.catalogue.clear();
      if (!cleared) {
        logger.debug(`[Stages] ${describeActor(MANAGER)} cleared the catalogue stamp, which was not set`);
        return { cleared: false };
      }

      logger.info(
        `[Stages] ${describeActor(MANAGER)} cleared the catalogue stamp (batch ${shortBatch(cleared.batch_id)} on ${quoteForLog(cleared.record.nodeName)})`,
      );
      await recordAudit(this.audit, {
        actor: MANAGER,
        action: 'catalogue.stamp.clear',
        details: { batchId: cleared.batch_id, nodeName: cleared.record.nodeName },
      });
      return { cleared: true };
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

    if (previous.retired_at !== null && written.retired_at === null) {
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
        written.retired_at === null ? '' : ', which stays retired: the record was observed before the retirement'
      }`,
    );
  }

  private async recordCatalogueStored(previous: CatalogueStampRow | null, written: CatalogueStampRow): Promise<void> {
    const who = describeActor(MANAGER);
    const { record } = written;
    const where = `batch ${shortBatch(record.batchId)} on ${quoteForLog(record.nodeName)}`;

    if (written.cleared_at !== null) {
      logger.debug(`[Stages] ${who} pushed the catalogue stamp, which stays cleared: it was observed before the clear`);
      return;
    }

    if (!previous || previous.cleared_at !== null) {
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
