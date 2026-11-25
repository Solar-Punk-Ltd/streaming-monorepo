import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationChannelSettingsByKind,
} from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type {
  NewWaitingDelivery,
  NotificationChannelRow,
  NotificationChannelSave,
  NotificationStore,
  WaitingDeliveryRow,
} from './NotificationStore.js';

interface ChannelDbRow {
  kind: NotificationChannelKind;
  enabled: boolean;
  settings: NotificationChannelSettingsByKind[NotificationChannelKind];
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  secret_key_version: number;
  saved_at: Date;
  saved_by: string;
  last_sent_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  last_test_at: Date | null;
  last_test_error: string | null;
}

interface DeliveryDbRow {
  id: string;
  channel: NotificationChannelKind;
  title: string;
  body: string;
  subjects: string[];
  raised_at: Date;
  attempts: number;
  last_error: string;
}

/** A waiting notice's id as `notification_deliveries` takes it: a BIGINT identity, written in decimal. */
const DELIVERY_ID = /^[1-9]\d{0,18}$/;

function channelOf(row: ChannelDbRow): NotificationChannelRow {
  return {
    kind: row.kind,
    enabled: row.enabled,
    settings: row.settings,
    secret: {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      authTag: row.secret_auth_tag,
      keyVersion: row.secret_key_version,
    },
    savedAt: row.saved_at,
    savedBy: row.saved_by,
    lastSentAt: row.last_sent_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastTestAt: row.last_test_at,
    lastTestError: row.last_test_error,
  } as NotificationChannelRow;
}

/**
 * The admin's notification channels and the notices that wait for one, in Postgres, migration 035. A channel's
 * secret is read and written sealed (`channelSecrets.ts`); nothing here opens one. A notice that waits goes with its
 * channel by the foreign key's ON DELETE CASCADE, and with a switch off in the same statement as the switch.
 */
export class NotificationRepository implements NotificationStore {
  constructor(private readonly pool: Pool) {}

  async channels(): Promise<NotificationChannelRow[]> {
    const result = await this.pool.query<ChannelDbRow>(
      `SELECT kind, enabled, settings, secret_ciphertext, secret_iv, secret_auth_tag, secret_key_version, saved_at,
              saved_by, last_sent_at, last_error, last_error_at, last_test_at, last_test_error
         FROM notification_channels
        ORDER BY array_position($1::text[], kind)`,
      [NOTIFICATION_CHANNEL_KINDS],
    );
    return result.rows.map(channelOf);
  }

  async saveChannel(channel: NotificationChannelSave, by: string, at: Date): Promise<boolean> {
    const settings = JSON.stringify(channel.settings);
    if (channel.secret === null) {
      const result = await this.pool.query(
        `UPDATE notification_channels SET settings = $2::jsonb, saved_at = $3, saved_by = $4 WHERE kind = $1`,
        [channel.kind, settings, at, by],
      );
      return result.rowCount === 1;
    }
    await this.pool.query(
      `INSERT INTO notification_channels (
         kind, settings, secret_ciphertext, secret_iv, secret_auth_tag, secret_key_version, saved_at, saved_by
       )
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind) DO UPDATE
          SET settings = EXCLUDED.settings,
              secret_ciphertext = EXCLUDED.secret_ciphertext,
              secret_iv = EXCLUDED.secret_iv,
              secret_auth_tag = EXCLUDED.secret_auth_tag,
              secret_key_version = EXCLUDED.secret_key_version,
              saved_at = EXCLUDED.saved_at,
              saved_by = EXCLUDED.saved_by`,
      [
        channel.kind,
        settings,
        channel.secret.ciphertext,
        channel.secret.iv,
        channel.secret.authTag,
        channel.secret.keyVersion,
        at,
        by,
      ],
    );
    return true;
  }

  /** The switch and, for a switch off, the drop of the channel's waiting notices are one statement. */
  async setEnabled(kind: NotificationChannelKind, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query<{ switched: number }>(
      `WITH switched AS (
         UPDATE notification_channels SET enabled = $2 WHERE kind = $1 RETURNING kind
       ), dropped AS (
         DELETE FROM notification_deliveries
          WHERE channel = $1 AND NOT $2 AND EXISTS (SELECT 1 FROM switched)
       )
       SELECT count(*)::int AS switched FROM switched`,
      [kind, enabled],
    );
    return result.rows[0]?.switched === 1;
  }

  async removeChannel(kind: NotificationChannelKind): Promise<void> {
    await this.pool.query('DELETE FROM notification_channels WHERE kind = $1', [kind]);
  }

  async recordSent(kind: NotificationChannelKind, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE notification_channels SET last_sent_at = $2, last_error = NULL, last_error_at = NULL WHERE kind = $1`,
      [kind, at],
    );
  }

  async recordFailed(kind: NotificationChannelKind, at: Date, error: string): Promise<void> {
    await this.pool.query('UPDATE notification_channels SET last_error = $3, last_error_at = $2 WHERE kind = $1', [
      kind,
      at,
      error,
    ]);
  }

  /**
   * One UPDATE that checks the last test's moment and writes the new one: a second request at the same time waits for
   * the first one's row lock, reads the moment it wrote, and claims nothing.
   */
  async claimTest(kind: NotificationChannelKind, at: Date, everySeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE notification_channels
          SET last_test_at = $2, last_test_error = NULL
        WHERE kind = $1
          AND (last_test_at IS NULL OR last_test_at <= $2::timestamptz - make_interval(secs => $3))`,
      [kind, at, everySeconds],
    );
    return result.rowCount === 1;
  }

  async recordTest(kind: NotificationChannelKind, error: string | null): Promise<void> {
    await this.pool.query('UPDATE notification_channels SET last_test_error = $2 WHERE kind = $1', [kind, error]);
  }

  async addWaiting(deliveries: readonly NewWaitingDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;
    const rows = deliveries.map((delivery) => ({
      channel: delivery.channel,
      title: delivery.title,
      body: delivery.text,
      subjects: delivery.subjects,
      raised_at: delivery.raisedAt.toISOString(),
      last_error: delivery.error,
    }));
    await this.pool.query(
      `INSERT INTO notification_deliveries (channel, title, body, subjects, raised_at, last_error)
       SELECT channel, title, body, subjects, raised_at, last_error
         FROM jsonb_to_recordset($1::jsonb)
           AS delivery (channel text, title text, body text, subjects text[], raised_at timestamptz, last_error text)`,
      [JSON.stringify(rows)],
    );
  }

  async waiting(): Promise<WaitingDeliveryRow[]> {
    const result = await this.pool.query<DeliveryDbRow>(
      `SELECT id::text, channel, title, body, subjects, raised_at, attempts, last_error
         FROM notification_deliveries
        ORDER BY raised_at, id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      title: row.title,
      text: row.body,
      subjects: row.subjects,
      raisedAt: row.raised_at,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
  }

  async waitingCounts(): Promise<Map<NotificationChannelKind, number>> {
    const result = await this.pool.query<{ channel: NotificationChannelKind; waiting: number }>(
      'SELECT channel, count(*)::int AS waiting FROM notification_deliveries GROUP BY channel',
    );
    return new Map(result.rows.map((row) => [row.channel, row.waiting]));
  }

  async recordAttempt(id: string, error: string): Promise<void> {
    if (!DELIVERY_ID.test(id)) return;
    await this.pool.query(
      'UPDATE notification_deliveries SET attempts = attempts + 1, last_error = $2 WHERE id = $1::bigint',
      [id, error],
    );
  }

  async removeWaiting(ids: readonly string[]): Promise<void> {
    const known = ids.filter((id) => DELIVERY_ID.test(id));
    if (known.length === 0) return;
    await this.pool.query('DELETE FROM notification_deliveries WHERE id = ANY($1::bigint[])', [known]);
  }
}
