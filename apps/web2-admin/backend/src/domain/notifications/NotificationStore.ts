import type { NotificationChannelKind, NotificationChannelSettingsByKind } from '@streaming-monorepo/web2-admin-common';

/**
 * A channel's secret as it is kept: encrypted with AES-256-GCM under the key of `keyVersion`. `channelSecrets.ts`
 * seals and opens it.
 */
export interface SealedSecret {
  ciphertext: Buffer;
  /** The 12 random bytes this encryption used. */
  iv: Buffer;
  /** GCM's 16-byte tag. */
  authTag: Buffer;
  /** Which key it is under. */
  keyVersion: number;
}

/** One row of `notification_channels`, migration 035: a saved channel. */
export type NotificationChannelRow = {
  [K in NotificationChannelKind]: {
    kind: K;
    enabled: boolean;
    settings: NotificationChannelSettingsByKind[K];
    secret: SealedSecret;
    savedAt: Date;
    savedBy: string;
    /** When it last took a notice. A test does not count. */
    lastSentAt: Date | null;
    /** Why its last notice could not be sent, null once one went out after it, and when that was. */
    lastError: string | null;
    lastErrorAt: Date | null;
    /** When a test notice was last sent on it, and why that could not be sent, or null. */
    lastTestAt: Date | null;
    lastTestError: string | null;
  };
}[NotificationChannelKind];

/** A channel to save: its settings as `storedChannelSettings` leaves them, and its secret sealed, or null to keep. */
export type NotificationChannelSave = {
  [K in NotificationChannelKind]: {
    kind: K;
    settings: NotificationChannelSettingsByKind[K];
    secret: SealedSecret | null;
  };
}[NotificationChannelKind];

/** A notice to keep for a channel that could not take it while another did. */
export interface NewWaitingDelivery {
  channel: NotificationChannelKind;
  title: string;
  text: string;
  /** What the notice tells of, in the names of whoever raised it. */
  subjects: readonly string[];
  /** When the notice was raised. */
  raisedAt: Date;
  /** Why the channel could not take it. */
  error: string;
}

/** One row of `notification_deliveries`: a notice that waits for a channel. */
export interface WaitingDeliveryRow {
  id: string;
  channel: NotificationChannelKind;
  title: string;
  text: string;
  subjects: string[];
  raisedAt: Date;
  /** How many times the channel was tried. */
  attempts: number;
  lastError: string;
}

/**
 * Where the admin keeps its notification channels and the notices that wait for one: Postgres, migration 035, or
 * memory in the unit tests. The routes save, switch and remove the channels; whoever sends writes how each send went
 * and the waiting notices.
 */
export interface NotificationStore {
  /** Every saved channel, in the order of `NOTIFICATION_CHANNEL_KINDS`. */
  channels(): Promise<NotificationChannelRow[]>;
  /**
   * Saves a channel. Its first save makes it, switched on; a later one replaces its settings, and its secret unless
   * that is null, and keeps its switch, its send state and its waiting notices. Answers false, and saves nothing,
   * when the secret is null and the channel has none.
   */
  saveChannel(channel: NotificationChannelSave, by: string, at: Date): Promise<boolean>;
  /**
   * Switches a saved channel on or off. Switching it off drops the notices that wait for it. Answers false for a
   * channel never saved.
   */
  setEnabled(kind: NotificationChannelKind, enabled: boolean): Promise<boolean>;
  /** Removes a channel with its secret and the notices that wait for it. */
  removeChannel(kind: NotificationChannelKind): Promise<void>;

  /** A channel took a notice: sets `lastSentAt` and clears `lastError`. */
  recordSent(kind: NotificationChannelKind, at: Date): Promise<void>;
  /** A channel could not take a notice: sets `lastError` and `lastErrorAt`. */
  recordFailed(kind: NotificationChannelKind, at: Date, error: string): Promise<void>;

  /**
   * Takes the channel's one test of this stretch: sets `lastTestAt` to `at` and answers true when the channel is
   * saved and its last test is `everySeconds` old or older, in one statement, so two requests at once send one test.
   */
  claimTest(kind: NotificationChannelKind, at: Date, everySeconds: number): Promise<boolean>;
  /** How the claimed test went: why it could not be sent, or null. */
  recordTest(kind: NotificationChannelKind, error: string | null): Promise<void>;

  addWaiting(deliveries: readonly NewWaitingDelivery[]): Promise<void>;
  /** Every notice that waits, the earliest raised first. */
  waiting(): Promise<WaitingDeliveryRow[]>;
  /** How many notices wait for each channel that has any. */
  waitingCounts(): Promise<Map<NotificationChannelKind, number>>;
  /** A waiting notice was tried again and failed: counts the try and keeps why. */
  recordAttempt(id: string, error: string): Promise<void>;
  /** Drops these waiting notices: taken at last, too old, or about nothing that stands. */
  removeWaiting(ids: readonly string[]): Promise<void>;
}
