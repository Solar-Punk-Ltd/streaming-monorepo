import {
  NOTICE_SERVICE_KINDS,
  NOTIFICATION_CHANNEL_KINDS,
  type NoticeServiceKind,
  type NoticeTopic,
  type NotificationChannelKind,
  storedNoticeTopics,
} from '@streaming-monorepo/web2-admin-common';

import type {
  NewWaitingNotice,
  NoticeDestinationKey,
  NoticeDestinationRow,
  NoticeRecipient,
  NoticeServiceCounts,
  NoticeServiceRow,
  NoticeServiceSave,
  NoticeStore,
  WaitingNoticeRow,
} from '../../../src/domain/notifications/NoticeStore.js';
import type {
  NewWaitingDelivery,
  NotificationChannelRow,
  NotificationChannelSave,
  NotificationStore,
  SealedSecret,
  WaitingDeliveryRow,
} from '../../../src/domain/notifications/NotificationStore.js';

function copySecret(secret: SealedSecret): SealedSecret {
  return {
    ciphertext: Buffer.from(secret.ciphertext),
    iv: Buffer.from(secret.iv),
    authTag: Buffer.from(secret.authTag),
    keyVersion: secret.keyVersion,
  };
}

function copyChannel(row: NotificationChannelRow): NotificationChannelRow {
  return { ...row, settings: structuredClone(row.settings), secret: copySecret(row.secret) } as NotificationChannelRow;
}

/** The checks of `notification_channels` on a secret, migration 035. */
function checkSecret(secret: SealedSecret): void {
  if (secret.ciphertext.length < 1 || secret.ciphertext.length > 512) {
    throw new Error('notification_channels CHECK: secret_ciphertext');
  }
  if (secret.iv.length !== 12) throw new Error('notification_channels CHECK: secret_iv');
  if (secret.authTag.length !== 16) throw new Error('notification_channels CHECK: secret_auth_tag');
  if (!Number.isInteger(secret.keyVersion) || secret.keyVersion < 1) {
    throw new Error('notification_channels CHECK: secret_key_version');
  }
}

/**
 * The admin's notification store in memory, with the checks of migration 035 that matter to a caller: a channel's
 * secret is whole, it was saved by someone, a waiting notice names a saved channel, has a title, a text and an error,
 * and goes with its channel when that is switched off or removed.
 *
 * `channelRows` and `waitingRows` are open, so a test can set a state up or read one back without the methods.
 */
export class InMemoryNotificationStore implements NotificationStore {
  readonly channelRows = new Map<NotificationChannelKind, NotificationChannelRow>();
  waitingRows: WaitingDeliveryRow[] = [];
  private nextId = 1;

  async channels(): Promise<NotificationChannelRow[]> {
    return NOTIFICATION_CHANNEL_KINDS.flatMap((kind) => {
      const row = this.channelRows.get(kind);
      return row ? [copyChannel(row)] : [];
    });
  }

  async saveChannel(channel: NotificationChannelSave, by: string, at: Date): Promise<boolean> {
    if (by === '') throw new Error('notification_channels CHECK: saved_by');
    if (typeof channel.settings !== 'object' || channel.settings === null || Array.isArray(channel.settings)) {
      throw new Error('notification_channels CHECK: settings');
    }
    if (channel.secret) checkSecret(channel.secret);
    const known = this.channelRows.get(channel.kind);
    if (!known) {
      if (!channel.secret) return false;
      this.channelRows.set(channel.kind, {
        kind: channel.kind,
        enabled: true,
        settings: structuredClone(channel.settings),
        secret: copySecret(channel.secret),
        savedAt: at,
        savedBy: by,
        lastSentAt: null,
        lastError: null,
        lastErrorAt: null,
        lastTestAt: null,
        lastTestError: null,
      } as NotificationChannelRow);
      return true;
    }
    this.channelRows.set(channel.kind, {
      ...known,
      settings: structuredClone(channel.settings),
      secret: channel.secret ? copySecret(channel.secret) : known.secret,
      savedAt: at,
      savedBy: by,
    } as NotificationChannelRow);
    return true;
  }

  async setEnabled(kind: NotificationChannelKind, enabled: boolean): Promise<boolean> {
    const row = this.channelRows.get(kind);
    if (!row) return false;
    this.channelRows.set(kind, { ...row, enabled });
    if (!enabled) this.waitingRows = this.waitingRows.filter((waiting) => waiting.channel !== kind);
    return true;
  }

  async removeChannel(kind: NotificationChannelKind): Promise<void> {
    this.channelRows.delete(kind);
    // As the foreign key's ON DELETE CASCADE does.
    this.waitingRows = this.waitingRows.filter((waiting) => waiting.channel !== kind);
  }

  async recordSent(kind: NotificationChannelKind, at: Date): Promise<void> {
    const row = this.channelRows.get(kind);
    if (row) this.channelRows.set(kind, { ...row, lastSentAt: at, lastError: null, lastErrorAt: null });
  }

  async recordFailed(kind: NotificationChannelKind, at: Date, error: string): Promise<void> {
    const row = this.channelRows.get(kind);
    if (row) this.channelRows.set(kind, { ...row, lastError: error, lastErrorAt: at });
  }

  async claimTest(kind: NotificationChannelKind, at: Date, everySeconds: number): Promise<boolean> {
    const row = this.channelRows.get(kind);
    if (!row) return false;
    if (row.lastTestAt !== null && at.getTime() - row.lastTestAt.getTime() < everySeconds * 1000) return false;
    this.channelRows.set(kind, { ...row, lastTestAt: at, lastTestError: null });
    return true;
  }

  async recordTest(kind: NotificationChannelKind, error: string | null): Promise<void> {
    const row = this.channelRows.get(kind);
    if (!row) return;
    if (error !== null && row.lastTestAt === null) throw new Error('notification_channels_test_whole');
    this.channelRows.set(kind, { ...row, lastTestError: error });
  }

  async addWaiting(deliveries: readonly NewWaitingDelivery[]): Promise<void> {
    for (const delivery of deliveries) {
      if (!this.channelRows.has(delivery.channel)) {
        throw new Error('notification_deliveries_channel_fkey');
      }
      if (delivery.title === '' || delivery.text === '' || delivery.error === '') {
        throw new Error('notification_deliveries CHECK');
      }
    }
    for (const delivery of deliveries) {
      this.waitingRows.push({
        id: String(this.nextId++),
        channel: delivery.channel,
        title: delivery.title,
        text: delivery.text,
        subjects: [...delivery.subjects],
        raisedAt: delivery.raisedAt,
        attempts: 1,
        lastError: delivery.error,
      });
    }
  }

  async waiting(): Promise<WaitingDeliveryRow[]> {
    return [...this.waitingRows]
      .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || Number(a.id) - Number(b.id))
      .map((row) => ({ ...row, subjects: [...row.subjects] }));
  }

  async waitingCounts(): Promise<Map<NotificationChannelKind, number>> {
    const counts = new Map<NotificationChannelKind, number>();
    for (const row of this.waitingRows) counts.set(row.channel, (counts.get(row.channel) ?? 0) + 1);
    return counts;
  }

  async recordAttempt(id: string, error: string): Promise<void> {
    if (error === '') throw new Error('notification_deliveries CHECK: last_error');
    const row = this.waitingRows.find((waiting) => waiting.id === id);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error;
  }

  async removeWaiting(ids: readonly string[]): Promise<void> {
    this.waitingRows = this.waitingRows.filter((row) => !ids.includes(row.id));
  }
}

function copyService(row: NoticeServiceRow): NoticeServiceRow {
  return { ...row, settings: structuredClone(row.settings), secret: copySecret(row.secret) } as NoticeServiceRow;
}

function destinationKeyOf(key: NoticeDestinationKey): string {
  return `${key.userId}:${key.kind}`;
}

function sameDestination(a: NoticeDestinationKey, b: NoticeDestinationKey): boolean {
  return a.userId === b.userId && a.kind === b.kind;
}

/**
 * The admin's notice store in memory, with the checks of migration 037 that matter to a caller: a service's secret is
 * whole and it was saved by someone; a destination's address is trimmed and not empty; a waiting notice names a saved
 * destination, has a title, a text and an error, and goes with its destination, and with its service when that is
 * switched off or removed; a user's rows go with them (`removeUser`).
 *
 * Users are ordered by when the store first heard of them, as the earliest made in the database would be.
 * `serviceRows`, `destinationRows`, `topicRows`, `codeRows` and `waitingRows` are open, so a test can set a state up or
 * read one back without the methods.
 */
export class InMemoryNoticeStore implements NoticeStore {
  readonly serviceRows = new Map<NoticeServiceKind, NoticeServiceRow>();
  readonly destinationRows = new Map<string, NoticeDestinationRow>();
  readonly topicRows = new Map<string, NoticeTopic[]>();
  readonly codeRows = new Map<string, { code: string; expiresAt: Date }>();
  waitingRows: WaitingNoticeRow[] = [];
  private readonly users: string[] = [];
  private nextId = 1;

  /** Deletes a user's rows, as `users`' ON DELETE CASCADE does. */
  removeUser(userId: string): void {
    for (const kind of NOTICE_SERVICE_KINDS) this.destinationRows.delete(destinationKeyOf({ userId, kind }));
    this.topicRows.delete(userId);
    this.codeRows.delete(userId);
    this.waitingRows = this.waitingRows.filter((row) => row.userId !== userId);
    const at = this.users.indexOf(userId);
    if (at >= 0) this.users.splice(at, 1);
  }

  private know(userId: string): void {
    if (userId === '') throw new Error('users: an empty id');
    if (!this.users.includes(userId)) this.users.push(userId);
  }

  // The services.

  async services(): Promise<NoticeServiceRow[]> {
    return NOTICE_SERVICE_KINDS.flatMap((kind) => {
      const row = this.serviceRows.get(kind);
      return row ? [copyService(row)] : [];
    });
  }

  async saveService(service: NoticeServiceSave, by: string, at: Date): Promise<boolean> {
    if (by === '') throw new Error('notification_services CHECK: saved_by');
    if (typeof service.settings !== 'object' || service.settings === null || Array.isArray(service.settings)) {
      throw new Error('notification_services CHECK: settings');
    }
    if (service.secret) checkSecret(service.secret);
    const known = this.serviceRows.get(service.kind);
    if (!known) {
      if (!service.secret) return false;
      this.serviceRows.set(service.kind, {
        kind: service.kind,
        enabled: true,
        settings: structuredClone(service.settings),
        secret: copySecret(service.secret),
        savedAt: at,
        savedBy: by,
        lastSentAt: null,
        lastFailure: null,
        lastFailureAt: null,
      } as NoticeServiceRow);
      return true;
    }
    this.serviceRows.set(service.kind, {
      ...known,
      settings: structuredClone(service.settings),
      secret: service.secret ? copySecret(service.secret) : known.secret,
      savedAt: at,
      savedBy: by,
    } as NoticeServiceRow);
    return true;
  }

  async setServiceEnabled(kind: NoticeServiceKind, enabled: boolean): Promise<boolean> {
    const row = this.serviceRows.get(kind);
    if (!row) return false;
    this.serviceRows.set(kind, { ...row, enabled } as NoticeServiceRow);
    if (!enabled) this.waitingRows = this.waitingRows.filter((waiting) => waiting.kind !== kind);
    return true;
  }

  async removeService(kind: NoticeServiceKind): Promise<void> {
    this.serviceRows.delete(kind);
    this.waitingRows = this.waitingRows.filter((waiting) => waiting.kind !== kind);
  }

  async recordServiceSent(kind: NoticeServiceKind, at: Date): Promise<void> {
    const row = this.serviceRows.get(kind);
    if (row) this.serviceRows.set(kind, { ...row, lastSentAt: at } as NoticeServiceRow);
  }

  async recordServiceFailure(kind: NoticeServiceKind, at: Date, failure: string): Promise<void> {
    const row = this.serviceRows.get(kind);
    if (row) this.serviceRows.set(kind, { ...row, lastFailure: failure, lastFailureAt: at } as NoticeServiceRow);
  }

  async serviceCounts(): Promise<NoticeServiceCounts[]> {
    const destinations = [...this.destinationRows.values()];
    return NOTICE_SERVICE_KINDS.map((kind) => {
      const on = destinations.filter((row) => row.kind === kind && row.enabled);
      return {
        kind,
        people: on.length,
        failing: on.filter((row) => row.lastError !== null).length,
        waiting: this.waitingRows.filter((row) => row.kind === kind).length,
      };
    });
  }

  // One user's own.

  async destinations(userId: string): Promise<NoticeDestinationRow[]> {
    return NOTICE_SERVICE_KINDS.flatMap((kind) => {
      const row = this.destinationRows.get(destinationKeyOf({ userId, kind }));
      return row ? [{ ...row }] : [];
    });
  }

  async saveDestination(
    key: NoticeDestinationKey,
    address: string,
    at: Date,
    startingTopics: readonly NoticeTopic[],
  ): Promise<void> {
    if (address === '' || address !== address.trim() || address.length > 254) {
      throw new Error('notification_destinations CHECK: address');
    }
    this.know(key.userId);
    const known = this.destinationRows.get(destinationKeyOf(key));
    const moved = known !== undefined && known.address !== address;
    if (moved) this.waitingRows = this.waitingRows.filter((row) => !sameDestination(row, key));
    this.destinationRows.set(
      destinationKeyOf(key),
      known === undefined
        ? {
            ...key,
            address,
            enabled: true,
            savedAt: at,
            lastSentAt: null,
            lastError: null,
            lastErrorAt: null,
            lastTestAt: null,
            lastTestError: null,
          }
        : moved
          ? {
              ...known,
              address,
              savedAt: at,
              lastSentAt: null,
              lastError: null,
              lastErrorAt: null,
              lastTestAt: null,
              lastTestError: null,
            }
          : { ...known, savedAt: at },
    );
    if (!this.topicRows.has(key.userId)) this.topicRows.set(key.userId, storedNoticeTopics(startingTopics));
  }

  async setDestinationEnabled(key: NoticeDestinationKey, enabled: boolean): Promise<boolean> {
    const row = this.destinationRows.get(destinationKeyOf(key));
    if (!row) return false;
    this.destinationRows.set(destinationKeyOf(key), { ...row, enabled });
    if (!enabled) this.waitingRows = this.waitingRows.filter((waiting) => !sameDestination(waiting, key));
    return true;
  }

  async removeDestination(key: NoticeDestinationKey): Promise<void> {
    this.destinationRows.delete(destinationKeyOf(key));
    this.waitingRows = this.waitingRows.filter((waiting) => !sameDestination(waiting, key));
  }

  async topics(userId: string): Promise<NoticeTopic[] | null> {
    const topics = this.topicRows.get(userId);
    return topics ? storedNoticeTopics(topics) : null;
  }

  async saveTopics(userId: string, topics: readonly NoticeTopic[], _at: Date): Promise<void> {
    this.know(userId);
    this.topicRows.set(userId, storedNoticeTopics(topics));
  }

  async waitingCounts(userId: string): Promise<Map<NoticeServiceKind, number>> {
    const counts = new Map<NoticeServiceKind, number>();
    for (const row of this.waitingRows) {
      if (row.userId === userId) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    return counts;
  }

  async recordSent(key: NoticeDestinationKey, at: Date): Promise<void> {
    const row = this.destinationRows.get(destinationKeyOf(key));
    if (row) {
      this.destinationRows.set(destinationKeyOf(key), { ...row, lastSentAt: at, lastError: null, lastErrorAt: null });
    }
  }

  async recordFailed(key: NoticeDestinationKey, at: Date, error: string): Promise<void> {
    const row = this.destinationRows.get(destinationKeyOf(key));
    if (row) this.destinationRows.set(destinationKeyOf(key), { ...row, lastError: error, lastErrorAt: at });
  }

  async claimTest(key: NoticeDestinationKey, at: Date, everySeconds: number): Promise<boolean> {
    const row = this.destinationRows.get(destinationKeyOf(key));
    if (!row) return false;
    if (row.lastTestAt !== null && at.getTime() - row.lastTestAt.getTime() < everySeconds * 1000) return false;
    this.destinationRows.set(destinationKeyOf(key), { ...row, lastTestAt: at, lastTestError: null });
    return true;
  }

  async recordTest(key: NoticeDestinationKey, error: string | null): Promise<void> {
    const row = this.destinationRows.get(destinationKeyOf(key));
    if (!row) return;
    if (error !== null && row.lastTestAt === null) throw new Error('notification_destinations_test_whole');
    this.destinationRows.set(destinationKeyOf(key), { ...row, lastTestError: error });
  }

  async startChatCode(userId: string, code: string, expiresAt: Date): Promise<void> {
    if (!/^[A-HJKMNP-Z2-9]{10}$/.test(code)) throw new Error('notification_chat_codes CHECK: code');
    this.know(userId);
    this.codeRows.set(userId, { code, expiresAt });
  }

  async chatCode(userId: string, now: Date): Promise<string | null> {
    const row = this.codeRows.get(userId);
    return row && row.expiresAt.getTime() > now.getTime() ? row.code : null;
  }

  // Everyone a notice can reach, and the notices that wait.

  async recipients(): Promise<NoticeRecipient[]> {
    return this.users.flatMap((userId) => {
      const topics = storedNoticeTopics(this.topicRows.get(userId) ?? []);
      const destinations = NOTICE_SERVICE_KINDS.flatMap((kind) => {
        const row = this.destinationRows.get(destinationKeyOf({ userId, kind }));
        return row && row.enabled && this.serviceRows.get(kind)?.enabled ? [{ ...row }] : [];
      });
      return topics.length > 0 && destinations.length > 0 ? [{ userId, topics, destinations }] : [];
    });
  }

  async addWaiting(notices: readonly NewWaitingNotice[]): Promise<void> {
    for (const notice of notices) {
      if (!this.destinationRows.has(destinationKeyOf(notice))) {
        throw new Error('notification_deliveries_destination_fkey');
      }
      if (notice.title === '' || notice.text === '' || notice.error === '') {
        throw new Error('notification_deliveries CHECK');
      }
    }
    for (const notice of notices) {
      this.waitingRows.push({
        id: String(this.nextId++),
        userId: notice.userId,
        kind: notice.kind,
        title: notice.title,
        text: notice.text,
        subjects: [...notice.subjects],
        raisedAt: notice.raisedAt,
        attempts: 1,
        lastError: notice.error,
      });
    }
  }

  async waiting(): Promise<WaitingNoticeRow[]> {
    return [...this.waitingRows]
      .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || Number(a.id) - Number(b.id))
      .map((row) => ({ ...row, subjects: [...row.subjects] }));
  }

  async recordAttempt(id: string, error: string): Promise<void> {
    if (error === '') throw new Error('notification_deliveries CHECK: last_error');
    const row = this.waitingRows.find((waiting) => waiting.id === id);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error;
  }

  async removeWaiting(ids: readonly string[]): Promise<void> {
    this.waitingRows = this.waitingRows.filter((row) => !ids.includes(row.id));
  }
}
