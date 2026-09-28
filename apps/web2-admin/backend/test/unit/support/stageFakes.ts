/**
 * In-memory stand-ins for the stage and catalogue stamp repositories, and records to push into them.
 *
 * The fakes copy the semantics that matter from the SQL in StageRepository: a record observed before the stored one
 * is kept out, a retired stage comes back only for a record observed after its retirement arrived, and a list never
 * carries the passphrase or the token hash. `now` is the admin's clock, which stamps `received_at`, `retired_at` and
 * `cleared_at`; a test moves it by hand.
 */
import type { CatalogueStampRecord, StageRecord } from '@streaming-monorepo/contracts';

import type { StageWrite } from '../../../src/domain/StageRepository.js';
import type { CatalogueStampStore, StageStore } from '../../../src/domain/StageService.js';
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
  /** Set to make the next write fail, as a lost connection would. */
  failNextUpsert: Error | null = null;

  constructor(private readonly clock: TestClock = new TestClock()) {}

  async list(): Promise<StageRow[]> {
    return [...this.rows.values()]
      .sort(
        (a, b) =>
          Number(a.retired_at !== null) - Number(b.retired_at !== null) ||
          a.name.localeCompare(b.name) ||
          a.stage_id.localeCompare(b.stage_id),
      )
      .map(listed);
  }

  async find(stageId: string): Promise<StageSecretsRow | null> {
    const row = this.rows.get(stageId);
    return row ? structuredClone(row) : null;
  }

  async upsert(write: StageWrite): Promise<StageRow | null> {
    if (this.failNextUpsert) {
      const failure = this.failNextUpsert;
      this.failNextUpsert = null;
      throw failure;
    }
    const { record } = write;
    const observedAt = new Date(record.observedAt);
    const existing = this.rows.get(record.stageId);
    if (existing && existing.observed_at.getTime() > observedAt.getTime()) return null;

    const retiredAt =
      existing?.retired_at && observedAt.getTime() <= existing.retired_at.getTime() ? existing.retired_at : null;
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
      retired_at: retiredAt,
      srt_passphrase: write.srtPassphrase,
      admin_token_sha256: write.adminToken?.sha256 ?? null,
    };
    this.rows.set(record.stageId, row);
    return listed(row);
  }

  async retire(stageId: string): Promise<StageRow | null> {
    const row = this.rows.get(stageId);
    if (!row || row.retired_at !== null) return null;
    row.retired_at = this.clock.now();
    return listed(row);
  }
}

export class FakeCatalogueStampStore implements CatalogueStampStore {
  row: CatalogueStampRow | null = null;

  constructor(private readonly clock: TestClock = new TestClock()) {}

  async get(): Promise<CatalogueStampRow | null> {
    return this.row ? structuredClone(this.row) : null;
  }

  async upsert(record: CatalogueStampRecord): Promise<CatalogueStampRow | null> {
    const observedAt = new Date(record.observedAt);
    const existing = this.row;
    if (existing && existing.observed_at.getTime() > observedAt.getTime()) return null;
    const clearedAt =
      existing?.cleared_at && observedAt.getTime() <= existing.cleared_at.getTime() ? existing.cleared_at : null;
    this.row = {
      manager_id: record.managerId,
      batch_id: record.batchId,
      record: structuredClone(record),
      observed_at: observedAt,
      received_at: this.clock.now(),
      cleared_at: clearedAt,
    };
    return structuredClone(this.row);
  }

  async clear(): Promise<CatalogueStampRow | null> {
    if (!this.row || this.row.cleared_at !== null) return null;
    this.row.cleared_at = this.clock.now();
    return structuredClone(this.row);
  }
}
