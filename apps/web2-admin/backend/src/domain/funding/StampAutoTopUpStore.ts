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
   * When the alert was given: handed to the mail service, or, with no mail set, shown on the page, which is when it
   * was recorded. Null until then. The wallet job's wait counts from it (`autoTopUpSendTiming`).
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
  mailedAt: Date | null;
}

/** The one row of `stamp_auto_topup_mail`: how mail went. */
export interface AutoTopUpMailRow {
  lastSentAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** When the last "top-ups coming up" mail went out. */
  lastComingMailAt: Date | null;
  /** When the standing warnings were last mailed again together. */
  lastRepeatMailAt: Date | null;
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
 * migration 034, or memory in the unit tests. The routes write the settings, the pauses, the email list and the marks;
 * the alert job writes the alerts, the warnings and the mail row; the tick writes each job's run.
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

  /** The email list, in the order it was saved. */
  emails(): Promise<string[]>;
  /** Replaces the whole list with these addresses, already trimmed and in lower case. */
  replaceEmails(emails: readonly string[], by: string, at: Date): Promise<void>;

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
  setUnreadSince(batchId: string, since: Date | null): Promise<void>;

  warnings(): Promise<AutoTopUpWarningRow[]>;
  /** Raises a warning, or words a standing one anew: one that stands keeps its `since` and its `mailedAt`. */
  raiseWarning(key: AutoTopUpWarningKey, message: string, at: Date): Promise<void>;
  clearWarning(key: AutoTopUpWarningKey): Promise<void>;
  setWarningsMailed(keys: readonly AutoTopUpWarningKey[], at: Date): Promise<void>;

  mail(): Promise<AutoTopUpMailRow>;
  /** Writes the named columns of the mail row and keeps the others. */
  recordMail(update: Partial<AutoTopUpMailRow>): Promise<void>;

  /**
   * Each of these stamps' latest top-up that the system asked for and that did not fail, from the stamp journal. The
   * stamp job leaves a stamp topped up within `AUTO_TOPUP_ONCE_PER_SECONDS`, and the row shows the last one.
   */
  lastSystemTopUps(batchIds: readonly string[]): Promise<AutoTopUpJournalledTopUp[]>;
  /** What the system sent from the brand wallet since `since`, from the send journal: the daily ceiling counts it. */
  systemSendsSince(since: Date): Promise<AutoTopUpJournalledSends>;
}
