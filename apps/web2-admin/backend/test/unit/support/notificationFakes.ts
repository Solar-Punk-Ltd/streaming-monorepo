import { NOTIFICATION_CHANNEL_KINDS, type NotificationChannelKind } from '@streaming-monorepo/web2-admin-common';

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
