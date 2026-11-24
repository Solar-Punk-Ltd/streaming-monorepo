import { AUTO_TOPUP_JOBS, type AutoTopUpJob, type AutoTopUpSettings } from '@streaming-monorepo/web2-admin-common';

import type { SendLockOutcome } from '../../../src/domain/funding/FundingTransferRepository.js';
import type {
  AutoTopUpAlert,
  AutoTopUpJobRow,
  AutoTopUpJournalledSends,
  AutoTopUpJournalledTopUp,
  AutoTopUpMailRow,
  AutoTopUpMarkRow,
  AutoTopUpSettingsRow,
  AutoTopUpWarningKey,
  AutoTopUpWarningRow,
  NewAutoTopUpMark,
  StampAutoTopUpStore,
} from '../../../src/domain/funding/StampAutoTopUpStore.js';

import type { InMemoryFundingStampStore, InMemoryFundingTransferStore } from './fundingFakes.js';

/** A batch id as migration 034 takes it: `0x` and 64 lower-case hex digits. */
const BATCH_ID = /^0x[0-9a-f]{64}$/;

function sameWarning(a: AutoTopUpWarningKey, b: AutoTopUpWarningKey): boolean {
  return a.kind === b.kind && a.batchId === b.batchId;
}

/**
 * Stamp auto top-up's store in memory, with migration 034's checks that matter to a caller: a job's pause and run are
 * whole, a stamp warning names a marked stamp and goes with its mark, an alert is recorded whole, and a batch id is
 * `0x` and 64 lower-case hex digits.
 *
 * `lastSystemTopUps` and `systemSendsSince` read the in-memory journals it is given, the rows the system asked for, as
 * the SQL reads the two tables. Without them both answer nothing.
 */
export class InMemoryStampAutoTopUpStore implements StampAutoTopUpStore {
  settingsRow: AutoTopUpSettingsRow | null = null;
  readonly jobRows = new Map<AutoTopUpJob, AutoTopUpJobRow>(
    AUTO_TOPUP_JOBS.map((job) => [
      job,
      { job, paused: false, pausedAt: null, pausedBy: null, lastRunAt: null, lastOk: null, lastOutcome: null },
    ]),
  );
  emailList: string[] = [];
  /** Who saved the email list last, and when. */
  emailsSaved: { by: string; at: Date } | null = null;
  readonly markRows = new Map<string, AutoTopUpMarkRow>();
  warningRows: AutoTopUpWarningRow[] = [];
  mailRow: AutoTopUpMailRow = {
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    lastComingMailAt: null,
    lastRepeatMailAt: null,
  };

  private locked = false;
  /** How many times the tick's lock was refused to a second taker. */
  lockRefusals = 0;
  /** When set, a taker holds the lock until it resolves before its work runs, so a test can meet it there. */
  lockGate: Promise<void> | null = null;

  constructor(
    private readonly journals: {
      transfers?: InMemoryFundingTransferStore;
      stamps?: InMemoryFundingStampStore;
    } = {},
  ) {}

  async withTickLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>> {
    if (this.locked) {
      this.lockRefusals += 1;
      return { locked: false };
    }
    this.locked = true;
    try {
      if (this.lockGate) await this.lockGate;
      return { locked: true, result: await work() };
    } finally {
      this.locked = false;
    }
  }

  async settings(): Promise<AutoTopUpSettingsRow | null> {
    return this.settingsRow ? { ...this.settingsRow } : null;
  }

  async saveSettings(settings: AutoTopUpSettings, by: string, at: Date): Promise<void> {
    this.settingsRow = { ...settings, updatedAt: at, updatedBy: by };
  }

  async jobs(): Promise<AutoTopUpJobRow[]> {
    return AUTO_TOPUP_JOBS.map((job) => ({ ...this.jobRows.get(job)! }));
  }

  async setPaused(job: AutoTopUpJob, paused: boolean, by: string, at: Date): Promise<void> {
    const row = this.jobRows.get(job)!;
    this.jobRows.set(job, { ...row, paused, pausedAt: paused ? at : null, pausedBy: paused ? by : null });
  }

  async recordRun(job: AutoTopUpJob, at: Date, ok: boolean, outcome: string): Promise<void> {
    const row = this.jobRows.get(job)!;
    this.jobRows.set(job, { ...row, lastRunAt: at, lastOk: ok, lastOutcome: outcome });
  }

  async emails(): Promise<string[]> {
    return [...this.emailList];
  }

  async replaceEmails(emails: readonly string[], by: string, at: Date): Promise<void> {
    for (const email of emails) {
      if (email !== email.trim().toLowerCase()) throw new Error(`stamp_auto_topup_emails CHECK: ${email}`);
    }
    if (new Set(emails).size !== emails.length) throw new Error('stamp_auto_topup_emails_pkey');
    this.emailList = [...emails];
    this.emailsSaved = { by, at };
  }

  async marks(): Promise<AutoTopUpMarkRow[]> {
    return [...this.markRows.values()]
      .sort((a, b) => a.markedAt.getTime() - b.markedAt.getTime() || a.batchId.localeCompare(b.batchId))
      .map((row) => ({ ...row, alert: row.alert ? { ...row.alert } : null }));
  }

  async mark(items: readonly NewAutoTopUpMark[], by: string, at: Date): Promise<void> {
    for (const item of items) {
      if (!BATCH_ID.test(item.batchId)) throw new Error(`stamp_auto_topup_marks CHECK: ${item.batchId}`);
    }
    for (const item of items) {
      if (this.markRows.has(item.batchId)) continue;
      this.markRows.set(item.batchId, {
        batchId: item.batchId,
        nodeId: item.nodeId,
        nodeLabel: item.nodeLabel,
        markedAt: at,
        markedBy: by,
        alert: null,
        unreadSince: null,
      });
    }
  }

  async unmark(batchIds: readonly string[]): Promise<void> {
    for (const batchId of batchIds) this.markRows.delete(batchId);
    // As the foreign key's ON DELETE CASCADE does.
    this.warningRows = this.warningRows.filter((row) => row.batchId === null || this.markRows.has(row.batchId));
  }

  async setAlert(batchId: string, alert: AutoTopUpAlert | null): Promise<void> {
    const row = this.markRows.get(batchId);
    if (!row) return;
    if (alert && BigInt(alert.costWithMarginPlur) < BigInt(alert.costPlur)) {
      throw new Error('stamp_auto_topup_marks_alert_whole');
    }
    this.markRows.set(batchId, { ...row, alert: alert ? { ...alert } : null });
  }

  async setAlerted(batchIds: readonly string[], at: Date): Promise<void> {
    for (const batchId of batchIds) {
      const row = this.markRows.get(batchId);
      if (!row?.alert || row.alert.alertedAt !== null) continue;
      this.markRows.set(batchId, { ...row, alert: { ...row.alert, alertedAt: at } });
    }
  }

  async setUnreadSince(batchId: string, since: Date | null): Promise<void> {
    const row = this.markRows.get(batchId);
    if (row) this.markRows.set(batchId, { ...row, unreadSince: since });
  }

  async warnings(): Promise<AutoTopUpWarningRow[]> {
    return [...this.warningRows].sort((a, b) => a.since.getTime() - b.since.getTime()).map((row) => ({ ...row }));
  }

  async raiseWarning(key: AutoTopUpWarningKey, message: string, at: Date): Promise<void> {
    const wallet = key.kind === 'wallet_xbzz' || key.kind === 'wallet_xdai';
    if (wallet !== (key.batchId === null)) throw new Error('stamp_auto_topup_warnings_subject');
    if (key.batchId !== null && !this.markRows.has(key.batchId)) {
      throw new Error('stamp_auto_topup_warnings_batch_id_fkey');
    }
    const standing = this.warningRows.find((row) => sameWarning(row, key));
    if (standing) {
      standing.message = message;
      return;
    }
    this.warningRows.push({ kind: key.kind, batchId: key.batchId, since: at, message, mailedAt: null });
  }

  async clearWarning(key: AutoTopUpWarningKey): Promise<void> {
    this.warningRows = this.warningRows.filter((row) => !sameWarning(row, key));
  }

  async setWarningsMailed(keys: readonly AutoTopUpWarningKey[], at: Date): Promise<void> {
    for (const row of this.warningRows) {
      if (keys.some((key) => sameWarning(row, key))) row.mailedAt = at;
    }
  }

  async mail(): Promise<AutoTopUpMailRow> {
    return { ...this.mailRow };
  }

  async recordMail(update: Partial<AutoTopUpMailRow>): Promise<void> {
    const next = { ...this.mailRow, ...update };
    if ((next.lastError === null) !== (next.lastErrorAt === null)) throw new Error('stamp_auto_topup_mail_error_whole');
    this.mailRow = next;
  }

  async lastSystemTopUps(batchIds: readonly string[]): Promise<AutoTopUpJournalledTopUp[]> {
    const latest = new Map<string, AutoTopUpJournalledTopUp>();
    for (const row of this.journals.stamps?.rows.values() ?? []) {
      if (row.requestedByKind !== 'system' || row.kind !== 'topup' || row.state === 'failed') continue;
      if (!batchIds.includes(row.batchId) || row.days === null || row.costPlur === null) continue;
      const known = latest.get(row.batchId);
      if (known && known.at.getTime() >= row.createdAt.getTime()) continue;
      latest.set(row.batchId, {
        batchId: row.batchId,
        at: row.createdAt,
        days: row.days,
        costPlur: row.costPlur,
        state: row.state,
      });
    }
    return batchIds.flatMap((batchId) => (latest.has(batchId) ? [latest.get(batchId)!] : []));
  }

  async systemSendsSince(since: Date): Promise<AutoTopUpJournalledSends> {
    let xbzz = 0n;
    const gasNodeIds = new Set<string>();
    for (const row of this.journals.transfers?.rows.values() ?? []) {
      if (row.requestedByKind !== 'system' || row.state === 'failed') continue;
      if (row.createdAt.getTime() < since.getTime()) continue;
      if (row.kind === 'xbzz') xbzz += BigInt(row.amount);
      else gasNodeIds.add(row.nodeId);
    }
    return { xbzzPlur: xbzz.toString(), gasNodeIds: [...gasNodeIds].sort() };
  }
}
