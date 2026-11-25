import {
  AUTO_TOPUP_JOBS,
  type AutoTopUpJob,
  type AutoTopUpSettings,
  type AutoTopUpWarningKind,
  type FundingItemState,
} from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import { type SendLockOutcome, withAdvisoryLock } from './FundingTransferRepository.js';
import type {
  AutoTopUpAlert,
  AutoTopUpJobRow,
  AutoTopUpJournalledSends,
  AutoTopUpJournalledTopUp,
  AutoTopUpMarkRow,
  AutoTopUpNoticesRow,
  AutoTopUpSettingsRow,
  AutoTopUpWarningKey,
  AutoTopUpWarningRow,
  NewAutoTopUpMark,
  StampAutoTopUpStore,
} from './StampAutoTopUpStore.js';

/** The key of the tick's advisory lock, by its name, as the send lock is named. */
const TICK_LOCK_NAME = 'web2-admin:stamp-auto-topup-tick';

interface SettingsDbRow {
  top_up_under_days: number;
  top_up_to_days: number;
  look_ahead_days: number;
  margin_percent: number;
  xdai_warning_wei: string;
  daily_ceiling_plur: string | null;
  updated_at: Date;
  updated_by: string;
}

interface JobDbRow {
  job: AutoTopUpJob;
  paused: boolean;
  paused_at: Date | null;
  paused_by: string | null;
  last_run_at: Date | null;
  last_ok: boolean | null;
  last_outcome: string | null;
}

interface MarkDbRow {
  batch_id: string;
  node_id: string;
  node_label: string;
  marked_at: Date;
  marked_by: string;
  alert_days: number | null;
  alert_cost_plur: string | null;
  alert_cost_with_margin_plur: string | null;
  alert_send_plur: string | null;
  alert_gas_send: boolean | null;
  alert_recorded_at: Date | null;
  alerted_at: Date | null;
  unread_since: Date | null;
}

interface WarningDbRow {
  kind: AutoTopUpWarningKind;
  batch_id: string | null;
  since: Date;
  message: string;
  notified_at: Date | null;
}

interface NoticesDbRow {
  last_coming_at: Date | null;
  last_repeat_at: Date | null;
}

const MARK_COLUMNS = `
  batch_id, node_id, node_label, marked_at, marked_by, alert_days, alert_cost_plur::text,
  alert_cost_with_margin_plur::text, alert_send_plur::text, alert_gas_send, alert_recorded_at, alerted_at,
  unread_since
`;

/** The notices row's columns, by the field of `AutoTopUpNoticesRow` each holds. */
const NOTICES_COLUMNS: Record<keyof AutoTopUpNoticesRow, string> = {
  lastComingAt: 'last_coming_at',
  lastRepeatAt: 'last_repeat_at',
};

function markOf(row: MarkDbRow): AutoTopUpMarkRow {
  const alert: AutoTopUpAlert | null =
    row.alert_days === null
      ? null
      : {
          days: row.alert_days,
          costPlur: row.alert_cost_plur!,
          costWithMarginPlur: row.alert_cost_with_margin_plur!,
          sendPlur: row.alert_send_plur!,
          gasSend: row.alert_gas_send!,
          recordedAt: row.alert_recorded_at!,
          alertedAt: row.alerted_at,
        };
  return {
    batchId: row.batch_id,
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    markedAt: row.marked_at,
    markedBy: row.marked_by,
    alert,
    unreadSince: row.unread_since,
  };
}

/**
 * Stamp auto top-up's store in Postgres, migrations 034 and 035. The tick's lock is a session advisory lock
 * ({@link withAdvisoryLock}), taken without waiting: one tick at a time across every process on the database. The two
 * journal reads take the rows the system asked for, which the partial indexes of migration 034 hold.
 */
export class StampAutoTopUpRepository implements StampAutoTopUpStore {
  constructor(private readonly pool: Pool) {}

  withTickLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>> {
    return withAdvisoryLock(this.pool, TICK_LOCK_NAME, work);
  }

  async settings(): Promise<AutoTopUpSettingsRow | null> {
    const result = await this.pool.query<SettingsDbRow>(
      `SELECT top_up_under_days, top_up_to_days, look_ahead_days, margin_percent, xdai_warning_wei::text,
              daily_ceiling_plur::text, updated_at, updated_by
         FROM stamp_auto_topup_settings`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      topUpUnderDays: row.top_up_under_days,
      topUpToDays: row.top_up_to_days,
      lookAheadDays: row.look_ahead_days,
      marginPercent: row.margin_percent,
      xdaiWarningWei: row.xdai_warning_wei,
      dailyCeilingPlur: row.daily_ceiling_plur,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async saveSettings(settings: AutoTopUpSettings, by: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO stamp_auto_topup_settings (
         id, top_up_under_days, top_up_to_days, look_ahead_days, margin_percent, xdai_warning_wei,
         daily_ceiling_plur, updated_at, updated_by
       )
       VALUES (TRUE, $1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8)
       ON CONFLICT (id) DO UPDATE
          SET top_up_under_days = EXCLUDED.top_up_under_days,
              top_up_to_days = EXCLUDED.top_up_to_days,
              look_ahead_days = EXCLUDED.look_ahead_days,
              margin_percent = EXCLUDED.margin_percent,
              xdai_warning_wei = EXCLUDED.xdai_warning_wei,
              daily_ceiling_plur = EXCLUDED.daily_ceiling_plur,
              updated_at = EXCLUDED.updated_at,
              updated_by = EXCLUDED.updated_by`,
      [
        settings.topUpUnderDays,
        settings.topUpToDays,
        settings.lookAheadDays,
        settings.marginPercent,
        settings.xdaiWarningWei,
        settings.dailyCeilingPlur,
        at,
        by,
      ],
    );
  }

  async jobs(): Promise<AutoTopUpJobRow[]> {
    const result = await this.pool.query<JobDbRow>(
      `SELECT job, paused, paused_at, paused_by, last_run_at, last_ok, last_outcome
         FROM stamp_auto_topup_jobs
        ORDER BY array_position($1::text[], job)`,
      [AUTO_TOPUP_JOBS],
    );
    return result.rows.map((row) => ({
      job: row.job,
      paused: row.paused,
      pausedAt: row.paused_at,
      pausedBy: row.paused_by,
      lastRunAt: row.last_run_at,
      lastOk: row.last_ok,
      lastOutcome: row.last_outcome,
    }));
  }

  async setPaused(job: AutoTopUpJob, paused: boolean, by: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE stamp_auto_topup_jobs
          SET paused = $2,
              paused_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END,
              paused_by = CASE WHEN $2 THEN $3::text ELSE NULL END
        WHERE job = $1`,
      [job, paused, by, at],
    );
  }

  async recordRun(job: AutoTopUpJob, at: Date, ok: boolean, outcome: string): Promise<void> {
    await this.pool.query(
      `UPDATE stamp_auto_topup_jobs SET last_run_at = $2, last_ok = $3, last_outcome = $4 WHERE job = $1`,
      [job, at, ok, outcome],
    );
  }

  async marks(): Promise<AutoTopUpMarkRow[]> {
    const result = await this.pool.query<MarkDbRow>(
      `SELECT ${MARK_COLUMNS} FROM stamp_auto_topup_marks ORDER BY marked_at, batch_id`,
    );
    return result.rows.map(markOf);
  }

  async mark(items: readonly NewAutoTopUpMark[], by: string, at: Date): Promise<void> {
    if (items.length === 0) return;
    await this.pool.query(
      `INSERT INTO stamp_auto_topup_marks (batch_id, node_id, node_label, marked_at, marked_by)
       SELECT batch_id, node_id, node_label, $4, $5
         FROM unnest($1::text[], $2::text[], $3::text[]) AS item (batch_id, node_id, node_label)
       ON CONFLICT (batch_id) DO NOTHING`,
      [
        items.map((item) => item.batchId),
        items.map((item) => item.nodeId),
        items.map((item) => item.nodeLabel),
        at,
        by,
      ],
    );
  }

  /** The stamp's warnings go with its mark, by the foreign key's ON DELETE CASCADE. */
  async unmark(batchIds: readonly string[]): Promise<void> {
    if (batchIds.length === 0) return;
    await this.pool.query('DELETE FROM stamp_auto_topup_marks WHERE batch_id = ANY($1::text[])', [batchIds]);
  }

  async setAlert(batchId: string, alert: AutoTopUpAlert | null): Promise<void> {
    await this.pool.query(
      `UPDATE stamp_auto_topup_marks
          SET alert_days = $2,
              alert_cost_plur = $3::numeric,
              alert_cost_with_margin_plur = $4::numeric,
              alert_send_plur = $5::numeric,
              alert_gas_send = $6,
              alert_recorded_at = $7,
              alerted_at = $8
        WHERE batch_id = $1`,
      [
        batchId,
        alert?.days ?? null,
        alert?.costPlur ?? null,
        alert?.costWithMarginPlur ?? null,
        alert?.sendPlur ?? null,
        alert?.gasSend ?? null,
        alert?.recordedAt ?? null,
        alert?.alertedAt ?? null,
      ],
    );
  }

  async setAlerted(batchIds: readonly string[], at: Date): Promise<void> {
    if (batchIds.length === 0) return;
    await this.pool.query(
      `UPDATE stamp_auto_topup_marks
          SET alerted_at = $2
        WHERE batch_id = ANY($1::text[]) AND alert_days IS NOT NULL AND alerted_at IS NULL`,
      [batchIds, at],
    );
  }

  async setUnreadSince(batchId: string, since: Date | null): Promise<void> {
    await this.pool.query('UPDATE stamp_auto_topup_marks SET unread_since = $2 WHERE batch_id = $1', [batchId, since]);
  }

  async warnings(): Promise<AutoTopUpWarningRow[]> {
    const result = await this.pool.query<WarningDbRow>(
      `SELECT kind, batch_id, since, message, notified_at
         FROM stamp_auto_topup_warnings
        ORDER BY since, kind, batch_id NULLS FIRST`,
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      batchId: row.batch_id,
      since: row.since,
      message: row.message,
      notifiedAt: row.notified_at,
    }));
  }

  async raiseWarning(key: AutoTopUpWarningKey, message: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO stamp_auto_topup_warnings (kind, batch_id, since, message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, COALESCE(batch_id, '')) DO UPDATE SET message = EXCLUDED.message`,
      [key.kind, key.batchId, at, message],
    );
  }

  async clearWarning(key: AutoTopUpWarningKey): Promise<void> {
    await this.pool.query(
      'DELETE FROM stamp_auto_topup_warnings WHERE kind = $1 AND batch_id IS NOT DISTINCT FROM $2::text',
      [key.kind, key.batchId],
    );
  }

  async setWarningsNotified(keys: readonly AutoTopUpWarningKey[], at: Date): Promise<void> {
    if (keys.length === 0) return;
    await this.pool.query(
      `UPDATE stamp_auto_topup_warnings
          SET notified_at = $3
        WHERE (kind, COALESCE(batch_id, '')) IN (
          SELECT kind, batch_id FROM unnest($1::text[], $2::text[]) AS named (kind, batch_id)
        )`,
      [keys.map((key) => key.kind), keys.map((key) => key.batchId ?? ''), at],
    );
  }

  async notices(): Promise<AutoTopUpNoticesRow> {
    const result = await this.pool.query<NoticesDbRow>(
      'SELECT last_coming_at, last_repeat_at FROM stamp_auto_topup_notices',
    );
    const row = result.rows[0];
    return { lastComingAt: row?.last_coming_at ?? null, lastRepeatAt: row?.last_repeat_at ?? null };
  }

  async recordNotices(update: Partial<AutoTopUpNoticesRow>): Promise<void> {
    const fields = (Object.keys(NOTICES_COLUMNS) as (keyof AutoTopUpNoticesRow)[]).filter((key) => key in update);
    if (fields.length === 0) return;
    // The column names come from NOTICES_COLUMNS alone; the values go as parameters.
    const assignments = fields.map((key, i) => `${NOTICES_COLUMNS[key]} = $${i + 1}`);
    await this.pool.query(
      `UPDATE stamp_auto_topup_notices SET ${assignments.join(', ')}`,
      fields.map((key) => update[key] ?? null),
    );
  }

  async lastSystemTopUps(batchIds: readonly string[]): Promise<AutoTopUpJournalledTopUp[]> {
    if (batchIds.length === 0) return [];
    const result = await this.pool.query<{
      batch_id: string;
      created_at: Date;
      days: number;
      cost_plur: string;
      state: FundingItemState;
    }>(
      `SELECT DISTINCT ON (batch_id) batch_id, created_at, days, cost_plur::text, state
         FROM funding_stamp_operations
        WHERE requested_by_kind = 'system' AND kind = 'topup' AND state <> 'failed'
          AND batch_id = ANY($1::text[])
        ORDER BY batch_id, created_at DESC, request_id DESC`,
      [batchIds],
    );
    const latest = new Map(result.rows.map((row) => [row.batch_id, row]));
    return batchIds.flatMap((batchId) => {
      const row = latest.get(batchId);
      return row ? [{ batchId, at: row.created_at, days: row.days, costPlur: row.cost_plur, state: row.state }] : [];
    });
  }

  async systemSendsSince(since: Date): Promise<AutoTopUpJournalledSends> {
    const result = await this.pool.query<{ xbzz_plur: string; gas_node_ids: string[] | null }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'xbzz'), 0)::text AS xbzz_plur,
              array_agg(DISTINCT node_id ORDER BY node_id) FILTER (WHERE kind = 'xdai') AS gas_node_ids
         FROM funding_transfers
        WHERE requested_by_kind = 'system' AND state <> 'failed' AND created_at >= $1`,
      [since],
    );
    const row = result.rows[0];
    return { xbzzPlur: row?.xbzz_plur ?? '0', gasNodeIds: row?.gas_node_ids ?? [] };
  }
}
