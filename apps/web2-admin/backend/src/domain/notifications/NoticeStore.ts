import type {
  NoticeServiceKind,
  NoticeServiceSettingsByKind,
  NoticeTopic,
} from '@streaming-monorepo/web2-admin-common';

/**
 * A service's secret as it is kept: encrypted with AES-256-GCM under the key of `keyVersion`. `channelSecrets.ts`
 * seals and opens it, bound to the label `notification_channels:<kind>:v1`, which a secret that migration 037 carried
 * over was sealed under as well.
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

/** One row of `notification_services`, migration 037: a saved service, which every user's notices go out through. */
export type NoticeServiceRow = {
  [K in NoticeServiceKind]: {
    kind: K;
    enabled: boolean;
    settings: NoticeServiceSettingsByKind[K];
    secret: SealedSecret;
    savedAt: Date;
    savedBy: string;
    /** When it last took a notice, for any user. A test does not count. */
    lastSentAt: Date | null;
    /** Why the latest send through it failed, in a sentence that names no user and no destination, and when. */
    lastFailure: string | null;
    lastFailureAt: Date | null;
  };
}[NoticeServiceKind];

/** A service to save: its settings as `storedServiceSettings` leaves them, and its secret sealed, or null to keep. */
export type NoticeServiceSave = {
  [K in NoticeServiceKind]: {
    kind: K;
    settings: NoticeServiceSettingsByKind[K];
    secret: SealedSecret | null;
  };
}[NoticeServiceKind];

/** How many users a service reaches, as every user may read it: numbers alone. */
export interface NoticeServiceCounts {
  kind: NoticeServiceKind;
  /** The destinations on it that are on. */
  people: number;
  /** How many of those could not take their last notice. */
  failing: number;
  /** The notices that wait for its destinations. */
  waiting: number;
}

/** What names one destination: the user it belongs to, and the service it is reached through. */
export interface NoticeDestinationKey {
  userId: string;
  kind: NoticeServiceKind;
}

/** One row of `notification_destinations`: where one user's notices go on one service. */
export interface NoticeDestinationRow extends NoticeDestinationKey {
  /** The email address or the Telegram chat's id, as `storedDestinationAddress` leaves it. */
  address: string;
  enabled: boolean;
  savedAt: Date;
  /** When it last took a notice. A test does not count. */
  lastSentAt: Date | null;
  /** Why its last notice could not be sent, null once one went out after it, and when that was. */
  lastError: string | null;
  lastErrorAt: Date | null;
  /** When its user last sent a test notice to it, and why that could not be sent, or null. */
  lastTestAt: Date | null;
  lastTestError: string | null;
}

/**
 * One person a notice can reach now: a user with topics ticked and one destination or more that is on, on a service
 * that is saved and on. `destinations` holds those destinations alone.
 */
export interface NoticeRecipient {
  userId: string;
  /** The topics the user ticked, each known one once. */
  topics: NoticeTopic[];
  destinations: NoticeDestinationRow[];
}

/** A notice to keep for a destination that could not take it while another took what it tells of. */
export interface NewWaitingNotice extends NoticeDestinationKey {
  title: string;
  text: string;
  /** What the notice tells of, in the names of whoever raised it. */
  subjects: readonly string[];
  /** When the notice was raised. */
  raisedAt: Date;
  /** Why the destination could not take it. */
  error: string;
}

/** One row of `notification_deliveries`: a notice that waits for a destination. */
export interface WaitingNoticeRow extends NoticeDestinationKey {
  id: string;
  title: string;
  text: string;
  subjects: string[];
  raisedAt: Date;
  /** How many times the destination was tried. */
  attempts: number;
  lastError: string;
}

/**
 * Where the admin keeps its notices' services, each user's destinations and topics, and the notices that wait for a
 * destination: Postgres, migration 037, or memory in the unit tests.
 *
 * What belongs to one user is read by `userId` alone: `destinations`, `topics`, `waitingCounts` and `chatCode` take
 * the id of the signed-in user from the session, never from a request's body or path. `recipients` and `waiting` read
 * every user's, for the `Notifier` that sends, and no route answers either.
 */
export interface NoticeStore {
  // The services.

  /** Every saved service, in the order of `NOTICE_SERVICE_KINDS`. */
  services(): Promise<NoticeServiceRow[]>;
  /**
   * Saves a service. Its first save makes it, switched on; a later one replaces its settings, and its secret unless
   * that is null, and keeps its switch, how its sends went and the waiting notices. Answers false, and saves nothing,
   * when the secret is null and the service has none.
   */
  saveService(service: NoticeServiceSave, by: string, at: Date): Promise<boolean>;
  /**
   * Switches a saved service on or off. Switching it off drops the notices that wait for its destinations. Answers
   * false for a service never saved.
   */
  setServiceEnabled(kind: NoticeServiceKind, enabled: boolean): Promise<boolean>;
  /**
   * Removes a service with its secret and the notices that wait for its destinations. The destinations stay, each
   * with its user, and reach nobody until the service is saved again.
   */
  removeService(kind: NoticeServiceKind): Promise<void>;
  /** A service took a notice for a destination: sets `lastSentAt`. */
  recordServiceSent(kind: NoticeServiceKind, at: Date): Promise<void>;
  /** A send through a service failed: sets `lastFailure`, a sentence that names no user and no destination. */
  recordServiceFailure(kind: NoticeServiceKind, at: Date, failure: string): Promise<void>;
  /** For each service, how many destinations it reaches, how many of them are failing, and how many notices wait. */
  serviceCounts(): Promise<NoticeServiceCounts[]>;

  // One user's own.

  /** The user's saved destinations, in the order of `NOTICE_SERVICE_KINDS`. */
  destinations(userId: string): Promise<NoticeDestinationRow[]>;
  /**
   * Saves the user's destination on a service. Its first save makes it, switched on; a later one keeps its switch. A
   * save with another address clears how its last notice and its last test went and drops the notices that waited for
   * the old one. In the same transaction, a user with no row of topics gets one with `startingTopics`.
   */
  saveDestination(
    key: NoticeDestinationKey,
    address: string,
    at: Date,
    startingTopics: readonly NoticeTopic[],
  ): Promise<void>;
  /**
   * Switches the user's saved destination on or off. Switching it off drops the notices that wait for it. Answers
   * false for one never saved.
   */
  setDestinationEnabled(key: NoticeDestinationKey, enabled: boolean): Promise<boolean>;
  /** Removes the user's destination with the notices that wait for it. */
  removeDestination(key: NoticeDestinationKey): Promise<void>;
  /** The topics the user ticked, each known one once in the order of `NOTICE_TOPICS`, or null while they have no row. */
  topics(userId: string): Promise<NoticeTopic[] | null>;
  /** Saves the user's topics, making their row or replacing what it held. */
  saveTopics(userId: string, topics: readonly NoticeTopic[], at: Date): Promise<void>;
  /** How many notices wait for each of the user's destinations that has any. */
  waitingCounts(userId: string): Promise<Map<NoticeServiceKind, number>>;

  /** A destination took a notice: sets `lastSentAt` and clears `lastError`. */
  recordSent(key: NoticeDestinationKey, at: Date): Promise<void>;
  /** A destination could not take a notice: sets `lastError` and `lastErrorAt`. */
  recordFailed(key: NoticeDestinationKey, at: Date, error: string): Promise<void>;
  /**
   * Takes the destination's one test of this stretch: sets `lastTestAt` to `at` and answers true when the destination
   * is saved and its last test is `everySeconds` old or older, in one statement, so two requests at once send one test.
   */
  claimTest(key: NoticeDestinationKey, at: Date, everySeconds: number): Promise<boolean>;
  /** How the claimed test went: why it could not be sent, or null. */
  recordTest(key: NoticeDestinationKey, error: string | null): Promise<void>;

  /** Starts the user's code to find their Telegram chat, in place of the one they had. */
  startChatCode(userId: string, code: string, expiresAt: Date): Promise<void>;
  /** The user's code that holds at `now`, or null: none was started, or the last one is over. */
  chatCode(userId: string, now: Date): Promise<string | null>;

  // Everyone a notice can reach, and the notices that wait.

  /** Every person a notice can reach now, the earliest user first. */
  recipients(): Promise<NoticeRecipient[]>;
  addWaiting(notices: readonly NewWaitingNotice[]): Promise<void>;
  /** Every notice that waits, the earliest raised first. */
  waiting(): Promise<WaitingNoticeRow[]>;
  /** A waiting notice was tried again and failed: counts the try and keeps why. */
  recordAttempt(id: string, error: string): Promise<void>;
  /** Drops these waiting notices: taken at last, too old, or about nothing that stands. */
  removeWaiting(ids: readonly string[]): Promise<void>;
}
