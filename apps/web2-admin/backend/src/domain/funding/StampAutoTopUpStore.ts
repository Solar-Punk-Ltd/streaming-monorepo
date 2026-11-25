import type {
  AutoTopUpJob,
  AutoTopUpSettings,
  AutoTopUpWarningKind,
  FundingItemState,
} from '@streaming-monorepo/web2-admin-common';

import type { SendLockOutcome } from './FundingTransferRepository.js';

/** The one row of `stamp_auto_topup_settings`, migration 034: the saved numbers, and who saved them when. */
export interface AutoTopUpSettingsRow extends AutoTopUpSettings {
  updatedAt: Date;
  updatedBy: string;
}

/** One row of `stamp_auto_topup_jobs`: whether the job is paused, and how its last run went. */
export interface AutoTopUpJobRow {
  job: AutoTopUpJob;
  paused: boolean;
  pausedAt: Date | null;
  pausedBy: string | null;
  lastRunAt: Date | null;
  lastOk: boolean | null;
  lastOutcome: string | null;
}

/**
 * The alert for a marked stamp's coming top-up, the `alert_*` columns of its mark. The alert job records it when the
 * stamp comes within two look-aheads of the threshold, and records it again with new figures when the top-up lacks
 * more than `sendPlur` (`autoTopUpWithinAlert`), which clears `alertedAt`. The wallet job reads it and never writes it.
 */
export interface AutoTopUpAlert {
  /** The whole days the top-up adds. */
  days: number;
  /** Its cost when the alert was recorded, PLUR as a decimal string. */
  costPlur: string;
  /** That cost plus the margin, PLUR. */
  costWithMarginPlur: string;
  /** The xBZZ the brand wallet sends the stamp's node for it, PLUR: `0` when the node held enough. */
  sendPlur: string;
  /** Whether its node is sent gas with it. */
  gasSend: boolean;
  recordedAt: Date;
  /**
   * When the alert was given: taken by one notification channel, or, with no channel on, shown on the page, which is
   * when it was recorded. Null until then. The wallet job's wait counts from it (`autoTopUpSendTiming`).
   */
  alertedAt: Date | null;
}

/** One row of `stamp_auto_topup_marks`: a marked stamp, the alert for its coming top-up, and how its node reads. */
export interface AutoTopUpMarkRow {
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  /** The node that held the batch when it was marked, which pays for its top-ups, and its label then. */
  nodeId: string;
  nodeLabel: string;
  markedAt: Date;
  markedBy: string;
  alert: AutoTopUpAlert | null;
  /** Since when its node could not be read, or its chain view was behind, without a break, or null while it reads well. */
  unreadSince: Date | null;
}

/** A stamp to mark: the batch, and the node that holds it with its label, as the manager lists them now. */
export interface NewAutoTopUpMark {
  batchId: string;
  nodeId: string;
  nodeLabel: string;
}

/** What names one warning: its kind, and its stamp, or null for the brand wallet's. */
export interface AutoTopUpWarningKey {
  kind: AutoTopUpWarningKind;
  batchId: string | null;
}

/** One row of `stamp_auto_topup_warnings`: a warning that stands. */
export interface AutoTopUpWarningRow extends AutoTopUpWarningKey {
  since: Date;
  message: string;
  /** When a notice last told of it, or null. */
  notifiedAt: Date | null;
}

/** The one row of `stamp_auto_topup_notices`, migration 035: when the two once-a-day notices last went out. */
export interface AutoTopUpNoticesRow {
  /** When the last "top-ups coming up" notice went out. */
  lastComingAt: Date | null;
  /** When the standing warnings last went out again together. */
  lastRepeatAt: Date | null;
}

/** What a notice names a warning by, among its subjects (`OutgoingNotice`). It stands while the warning does. */
export function autoTopUpWarningSubject(key: AutoTopUpWarningKey): string {
  return `auto-top-up/warning/${key.kind}/${key.batchId ?? ''}`;
}

/** What a notice names a stamp's coming top-up by, among its subjects. It stands while the stamp's alert is recorded. */
export function autoTopUpComingSubject(batchId: string): string {
  return `auto-top-up/coming/${batchId}`;
}

/** A stamp's last automatic top-up, from the stamp journal's rows the system asked for. */
export interface AutoTopUpJournalledTopUp {
  batchId: string;
  at: Date;
  days: number;
  costPlur: string;
  state: FundingItemState;
}

/** What the wallet job sent since a moment, from the send journal's rows the system asked for. */
export interface AutoTopUpJournalledSends {
  /** The sum of its xBZZ transfers that did not fail, PLUR as a decimal string. */
  xbzzPlur: string;
  /** The nodes it sent xDAI to in transfers that did not fail. */
  gasNodeIds: string[];
}

/**
 * Where stamp auto top-up keeps its marks, its settings and what the three jobs hold between their runs: Postgres,
 * migrations 034 and 035, or memory in the unit tests. The routes write the settings, the pauses and the marks; the
 * alert job writes the alerts, `unreadSince` and the notices row; the tick writes each job's run.
 *
 * A warning is written by the job that sees its cause, at once, so it stands in the database whichever backend runs
 * the next tick:
 *
 * - `topup_failed` is raised by the stamp job for an operation refused or failed, a stamp due again within 24 hours,
 *   and a node the admin funds no more; by the wallet job for a stamp due for an hour that no send can go for, because
 *   of the daily ceiling, a brand wallet that is short, an unconfirmed or changed address, or the hold of an `unknown`
 *   send; and by the alert job for a node unread or behind for an hour, and for a node short for an hour while the
 *   wallet job is paused.
 * - `topup_failed` is cleared by the stamp job after a top-up, and by the alert job once the stamp is due no longer.
 * - `wallet_xbzz`, `wallet_xdai` and `stamp_expired` are raised and cleared by the alert job.
 *
 * The alert job sends the notices of every warning that stands, whichever job raised it, through the admin's
 * `Notifier`: the channels of the Notifications page.
 */
export interface StampAutoTopUpStore {
  /**
   * Runs `work` while holding the tick's advisory lock, or answers `{ locked: false }` without running it when another
   * process holds it. Taken without waiting, so one backend runs a tick and any other skips it.
   */
  withTickLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>>;

  /** The saved numbers, or null while none were saved and `AUTO_TOPUP_DEFAULTS` hold. */
  settings(): Promise<AutoTopUpSettingsRow | null>;
  saveSettings(settings: AutoTopUpSettings, by: string, at: Date): Promise<void>;

  /** The three jobs, in the order of `AUTO_TOPUP_JOBS`. */
  jobs(): Promise<AutoTopUpJobRow[]>;
  setPaused(job: AutoTopUpJob, paused: boolean, by: string, at: Date): Promise<void>;
  recordRun(job: AutoTopUpJob, at: Date, ok: boolean, outcome: string): Promise<void>;

  /** Every marked stamp, the earliest mark first. */
  marks(): Promise<AutoTopUpMarkRow[]>;
  /** Marks these stamps. One already marked keeps its row as it is. */
  mark(items: readonly NewAutoTopUpMark[], by: string, at: Date): Promise<void>;
  /** Takes the mark off these stamps, with each one's alert and warnings. */
  unmark(batchIds: readonly string[]): Promise<void>;
  /** Records the alert for a stamp's coming top-up, or clears it with null once it is topped up or healthy again. */
  setAlert(batchId: string, alert: AutoTopUpAlert | null): Promise<void>;
  /** Sets `alertedAt` on the recorded alerts of these stamps that have none yet. */
  setAlerted(batchIds: readonly string[], at: Date): Promise<void>;
  /** Writes since when a stamp's node is unread or behind, or null once it reads well: the alert job's, each tick. */
  setUnreadSince(batchId: string, since: Date | null): Promise<void>;

  /** Every warning that stands, whichever job raised it. */
  warnings(): Promise<AutoTopUpWarningRow[]>;
  /** Raises a warning, or words a standing one anew: one that stands keeps its `since` and its `notifiedAt`. */
  raiseWarning(key: AutoTopUpWarningKey, message: string, at: Date): Promise<void>;
  clearWarning(key: AutoTopUpWarningKey): Promise<void>;
  /** Sets `notifiedAt` on these warnings: a notice that told of them was taken by a channel. */
  setWarningsNotified(keys: readonly AutoTopUpWarningKey[], at: Date): Promise<void>;

  notices(): Promise<AutoTopUpNoticesRow>;
  /** Writes the named columns of the notices row and keeps the others. */
  recordNotices(update: Partial<AutoTopUpNoticesRow>): Promise<void>;

  /**
   * Each of these stamps' latest top-up that the system asked for and that did not fail, from the stamp journal. The
   * stamp job leaves a stamp topped up within `AUTO_TOPUP_ONCE_PER_SECONDS`, and the row shows the last one.
   */
  lastSystemTopUps(batchIds: readonly string[]): Promise<AutoTopUpJournalledTopUp[]>;
  /** What the system sent from the brand wallet since `since`, from the send journal: the daily ceiling counts it. */
  systemSendsSince(since: Date): Promise<AutoTopUpJournalledSends>;
}
