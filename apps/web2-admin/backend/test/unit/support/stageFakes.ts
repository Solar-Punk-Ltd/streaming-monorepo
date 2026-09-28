/**
 * In-memory stand-ins for the stage and catalogue stamp repositories, and records to push into them.
 *
 * The fakes copy the semantics that matter from the SQL in StageRepository: a record observed before the stored one
 * is kept out; a retirement names the manager's moment, is not taken against a record observed after it, and is kept
 * as a tombstone for a stage never stored; a retired stage comes back only for a record observed after the moment
 * its retirement names; and a list never carries the passphrase or the token hash. `now` is the admin's clock, which
 * only stamps when something arrived; a test moves it by hand.
 */
import type { CatalogueStampRecord, StageRecord } from '@streaming-monorepo/contracts';

import type { RetireOutcome, StageWrite } from '../../../src/domain/StageRepository.js';
import { splitStageRecord, type CatalogueStampStore, type StageStore } from '../../../src/domain/StageService.js';
import type { CatalogueStampRow, StageRow, StageSecretsRow } from '../../../src/types/index.js';

export const STAGE_ID = '5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f';
export const MANAGER_ID = '0d9e8f7a-6b5c-4d3e-9f21-a0b1c2d3e4f5';
export const STAGE_OWNER = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
export const SRT_PASSPHRASE = 'stage-passphrase-do-not-print';
export const TOKEN_SHA256 = 'aa'.repeat(32);
export const BATCH_ID = 'b1'.repeat(32);
export const CATALOGUE_BATCH_ID = 'c2'.repeat(32);

/** A stage record as the manager pushes one, already parsed. */
export function stageRecord(over: Partial<StageRecord> = {}): StageRecord {
  return {
    schemaVersion: 1,
    stageId: STAGE_ID,
    managerId: MANAGER_ID,
    name: 'Main stage',
    kind: 'abr-uploader',
    engine: 'srs',
    stackVersion: '1.4.0',
    status: 'running',
    observedAt: '2026-09-28T10:00:00.000Z',
    ingest: {
      host: 'ingest.example.org',
      srtPort: 10061,
      rtmpPort: 10062,
      rtmpPublic: false,
      srtPassphrase: SRT_PASSPHRASE,
    },
    owner: STAGE_OWNER,
    rungs: [
      {
        name: '720p',
        stamp: { batchId: BATCH_ID, state: 'active', ttlSeconds: 5 * 86_400, fillRatio: 0.25, immutable: false },
        chequebook: { health: 'ok', availableBzz: '12.5' },
      },
    ],
    uploader: { state: 'ready', reasons: [] },
    readiness: { tone: 'ready', reasons: [] },
    adminToken: { sha256: TOKEN_SHA256, kind: 'shared' },
    ...over,
  };
}

/** The catalogue stamp record as the manager pushes one, already parsed. */
export function catalogueStampRecord(over: Partial<CatalogueStampRecord> = {}): CatalogueStampRecord {
  return {
    schemaVersion: 1,
    managerId: MANAGER_ID,
    nodeName: 'catalogue-node',
    beeApiUrl: 'http://192.0.2.10:1633',
    batchId: CATALOGUE_BATCH_ID,
    immutable: true,
    depth: 22,
    state: 'active',
    ttlSeconds: 30 * 86_400,
    fillRatio: 0.01,
    designatedAt: '2026-09-27T09:00:00.000Z',
    observedAt: '2026-09-28T10:00:00.000Z',
    ...over,
  };
}

/** An admin clock a test sets by hand. */
export class TestClock {
  constructor(public current = new Date('2026-09-28T10:00:05.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

function listed(row: StageSecretsRow): StageRow {
  const { srt_passphrase: _passphrase, admin_token_sha256: _hash, ...rest } = row;
  return structuredClone(rest);
}

export class FakeStageStore implements StageStore {
  readonly rows = new Map<string, StageSecretsRow>();
  /** Retirements of stages never stored, by id: `stage_retirements`. */
  readonly tombstones = new Map<string, Date>();
  /** Set to make the next write fail, as a lost connection would. */
  failNextUpsert: Error | null = null;

  constructor(private readonly clock: TestClock = new TestClock()) {}

  async list(): Promise<StageRow[]> {
    return [...this.rows.values()]
      .sort(
        (a, b) =>
          Number(a.retired_observed_at !== null) - Number(b.retired_observed_at !== null) ||
          a.name.localeCompare(b.name) ||
          a.stage_id.localeCompare(b.stage_id),
      )
      .map(listed);
  }

  async find(stageId: string): Promise<StageSecretsRow | null> {
    const row = this.rows.get(stageId);
    return row ? structuredClone(row) : null;
  }

  /** As the SQL is: the columns a list reads, never the passphrase or the token hash. */
  async findSummary(stageId: string): Promise<StageRow | null> {
    const row = this.rows.get(stageId);
    return row ? listed(row) : null;
  }

  /** As the SQL is: active stages whose own token has this sha256, two at most, never the hash itself. */
  async findActiveByOwnTokenSha256(sha256: string): Promise<StageRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.admin_token_sha256 === sha256 && row.admin_token_kind === 'own' && row.retired_observed_at === null,
      )
      .sort((a, b) => a.stage_id.localeCompare(b.stage_id))
      .slice(0, 2)
      .map(listed);
  }

  /**
   * Whether the stage can take a stream, as the stream UPDATE's move branch
   * asks the stages table: stored, not retired, on SRS.
   */
  takesStreams(stageId: string): boolean {
    const row = this.rows.get(stageId);
    return row !== undefined && row.retired_observed_at === null && row.engine === 'srs';
  }

  async upsert(write: StageWrite): Promise<StageRow | null> {
    if (this.failNextUpsert) {
      const failure = this.failNextUpsert;
      this.failNextUpsert = null;
      throw failure;
    }
    const { record } = write;
    const observedAt = new Date(record.observedAt);
    const tombstone = this.tombstones.get(record.stageId);
    if (tombstone && tombstone.getTime() >= observedAt.getTime()) return null;
    this.tombstones.delete(record.stageId);
    const existing = this.rows.get(record.stageId);
    if (existing && existing.observed_at.getTime() > observedAt.getTime()) return null;

    const staysRetired =
      existing?.retired_observed_at != null && observedAt.getTime() <= existing.retired_observed_at.getTime();
    const row: StageSecretsRow = {
      stage_id: record.stageId,
      manager_id: record.managerId,
      name: record.name,
      kind: record.kind,
      engine: record.engine,
      owner: record.owner,
      record: structuredClone(record),
      has_srt_passphrase: write.srtPassphrase !== null,
      admin_token_kind: write.adminToken?.kind ?? null,
      observed_at: observedAt,
      received_at: this.clock.now(),
      retired_observed_at: staysRetired ? existing.retired_observed_at : null,
      retired_at: staysRetired ? existing.retired_at : null,
      srt_passphrase: write.srtPassphrase,
      admin_token_sha256: write.adminToken?.sha256 ?? null,
    };
    this.rows.set(record.stageId, row);
    return listed(row);
  }

  async retire(stageId: string, observedAt: string): Promise<RetireOutcome<StageRow>> {
    const at = new Date(observedAt);
    const row = this.rows.get(stageId);
    if (!row) {
      const kept = this.tombstones.get(stageId);
      this.tombstones.set(stageId, kept && kept.getTime() > at.getTime() ? kept : at);
      return { outcome: 'unknown' };
    }
    if (row.observed_at.getTime() > at.getTime()) return { outcome: 'newer' };
    if (row.retired_observed_at !== null) {
      if (at.getTime() > row.retired_observed_at.getTime()) row.retired_observed_at = at;
      return { outcome: 'already' };
    }
    row.retired_observed_at = at;
    row.retired_at = this.clock.now();
    return { outcome: 'done', row: listed(row) };
  }
}

/**
 * A stage store holding the stage `stageRecord()` pushes, `STAGE_ID`, which
 * `streamRow()` puts every stream on. Filled synchronously, for the setups
 * that are not async.
 */
export function stagesWithMain(clock: TestClock = new TestClock()): FakeStageStore {
  const stages = new FakeStageStore(clock);
  // `upsert` reaches no `await`, so the row is in place when this returns.
  void stages.upsert(splitStageRecord(stageRecord()));
  return stages;
}

export class FakeCatalogueStampStore implements CatalogueStampStore {
  row: CatalogueStampRow | null = null;
  /** Every batch `pin` was asked to pin, in order, whether it changed anything or not. */
  readonly pins: string[] = [];

  constructor(private readonly clock: TestClock = new TestClock()) {}

  async get(): Promise<CatalogueStampRow | null> {
    return this.row ? structuredClone(this.row) : null;
  }

  async upsert(record: CatalogueStampRecord): Promise<CatalogueStampRow | null> {
    const observedAt = new Date(record.observedAt);
    const existing = this.row;
    if (existing && existing.observed_at.getTime() > observedAt.getTime()) return null;
    const afterClear =
      existing?.cleared_observed_at == null || observedAt.getTime() > existing.cleared_observed_at.getTime();
    if (existing && existing.record === null && !afterClear) return null;
    this.row = {
      manager_id: record.managerId,
      batch_id: record.batchId,
      record: structuredClone(record),
      observed_at: observedAt,
      received_at: this.clock.now(),
      cleared_observed_at: afterClear ? null : existing!.cleared_observed_at,
      cleared_at: afterClear ? null : existing!.cleared_at,
      active_batch_id: existing?.active_batch_id ?? null,
      active_record:
        existing?.active_batch_id === record.batchId ? structuredClone(record) : (existing?.active_record ?? null),
      active_pinned_at: existing?.active_pinned_at ?? null,
    };
    return structuredClone(this.row);
  }

  async clear(observedAt: string): Promise<RetireOutcome<CatalogueStampRow>> {
    const at = new Date(observedAt);
    const row = this.row;
    if (!row) {
      this.row = {
        manager_id: null,
        batch_id: null,
        record: null,
        observed_at: at,
        received_at: this.clock.now(),
        cleared_observed_at: at,
        cleared_at: this.clock.now(),
        active_batch_id: null,
        active_record: null,
        active_pinned_at: null,
      };
      return { outcome: 'unknown' };
    }
    if (row.observed_at.getTime() > at.getTime()) return { outcome: 'newer' };
    if (row.cleared_observed_at !== null) {
      if (at.getTime() > row.cleared_observed_at.getTime()) row.cleared_observed_at = at;
      return { outcome: 'already' };
    }
    row.cleared_observed_at = at;
    row.cleared_at = this.clock.now();
    return { outcome: 'done', row: structuredClone(row) };
  }

  /**
   * As the SQL: pins the batch unless it is pinned already, keeping the stored designated record when it is for the
   * same batch and `record` otherwise, and says whether it changed anything.
   */
  async pin(record: CatalogueStampRecord): Promise<boolean> {
    this.pins.push(record.batchId);
    if (!this.row || this.row.active_batch_id === record.batchId) return false;
    this.row.active_batch_id = record.batchId;
    this.row.active_record = structuredClone(this.row.record?.batchId === record.batchId ? this.row.record : record);
    this.row.active_pinned_at = this.clock.now();
    return true;
  }
}
