import {
  NOTICE_SERVICE_KINDS,
  type NoticeServiceKind,
  type NoticeServiceSettingsByKind,
  type NoticeTopic,
  storedNoticeTopics,
} from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

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
} from './NoticeStore.js';

interface ServiceDbRow {
  kind: NoticeServiceKind;
  enabled: boolean;
  settings: NoticeServiceSettingsByKind[NoticeServiceKind];
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  secret_key_version: number;
  saved_at: Date;
  saved_by: string;
  last_sent_at: Date | null;
  last_failure: string | null;
  last_failure_at: Date | null;
}

interface DestinationDbRow {
  user_id: string;
  kind: NoticeServiceKind;
  address: string;
  enabled: boolean;
  saved_at: Date;
  last_sent_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  last_test_at: Date | null;
  last_test_error: string | null;
}

interface DeliveryDbRow {
  id: string;
  user_id: string;
  kind: NoticeServiceKind;
  title: string;
  body: string;
  subjects: string[];
  raised_at: Date;
  attempts: number;
  last_error: string;
}

/** A waiting notice's id as `notification_deliveries` takes it: a BIGINT identity, written in decimal. */
const DELIVERY_ID = /^[1-9]\d{0,18}$/;

/** A user's id as the tables take it: a UUID. Anything else names nobody, and is read as such rather than refused. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICE_COLUMNS = `kind, enabled, settings, secret_ciphertext, secret_iv, secret_auth_tag, secret_key_version,
  saved_at, saved_by, last_sent_at, last_failure, last_failure_at`;

const DESTINATION_COLUMNS = `user_id, kind, address, enabled, saved_at, last_sent_at, last_error, last_error_at,
  last_test_at, last_test_error`;

function serviceOf(row: ServiceDbRow): NoticeServiceRow {
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
    lastFailure: row.last_failure,
    lastFailureAt: row.last_failure_at,
  } as NoticeServiceRow;
}

function destinationOf(row: DestinationDbRow): NoticeDestinationRow {
  return {
    userId: row.user_id,
    kind: row.kind,
    address: row.address,
    enabled: row.enabled,
    savedAt: row.saved_at,
    lastSentAt: row.last_sent_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastTestAt: row.last_test_at,
    lastTestError: row.last_test_error,
  };
}

/**
 * The admin's notification services, each user's destinations, topics and code to find their Telegram chat, and the
 * notices that wait for a destination, in Postgres, migration 037. A service's secret is read and written sealed
 * (`channelSecrets.ts`); nothing here opens one.
 *
 * What belongs to a user goes with them: every one of their rows has ON DELETE CASCADE on `users`, and a waiting
 * notice goes with its destination by the same. A waiting notice has no key on its service, so a service switched off
 * or removed drops its destinations' notices in the same statement.
 */
export class NoticeRepository implements NoticeStore {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------------ the services

  async services(): Promise<NoticeServiceRow[]> {
    const result = await this.pool.query<ServiceDbRow>(
      `SELECT ${SERVICE_COLUMNS}
         FROM notification_services
        ORDER BY array_position($1::text[], kind)`,
      [NOTICE_SERVICE_KINDS],
    );
    return result.rows.map(serviceOf);
  }

  async saveService(service: NoticeServiceSave, by: string, at: Date): Promise<boolean> {
    const settings = JSON.stringify(service.settings);
    if (service.secret === null) {
      const result = await this.pool.query(
        `UPDATE notification_services SET settings = $2::jsonb, saved_at = $3, saved_by = $4 WHERE kind = $1`,
        [service.kind, settings, at, by],
      );
      return result.rowCount === 1;
    }
    await this.pool.query(
      `INSERT INTO notification_services (
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
        service.kind,
        settings,
        service.secret.ciphertext,
        service.secret.iv,
        service.secret.authTag,
        service.secret.keyVersion,
        at,
        by,
      ],
    );
    return true;
  }

  /** The switch and, for a switch off, the drop of its destinations' waiting notices are one statement. */
  async setServiceEnabled(kind: NoticeServiceKind, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query<{ switched: number }>(
      `WITH switched AS (
         UPDATE notification_services SET enabled = $2 WHERE kind = $1 RETURNING kind
       ), dropped AS (
         DELETE FROM notification_deliveries
          WHERE kind = $1 AND NOT $2 AND EXISTS (SELECT 1 FROM switched)
       )
       SELECT count(*)::int AS switched FROM switched`,
      [kind, enabled],
    );
    return result.rows[0]?.switched === 1;
  }

  async removeService(kind: NoticeServiceKind): Promise<void> {
    await this.pool.query(
      `WITH removed AS (
         DELETE FROM notification_services WHERE kind = $1
       )
       DELETE FROM notification_deliveries WHERE kind = $1`,
      [kind],
    );
  }

  async recordServiceSent(kind: NoticeServiceKind, at: Date): Promise<void> {
    await this.pool.query('UPDATE notification_services SET last_sent_at = $2 WHERE kind = $1', [kind, at]);
  }

  async recordServiceFailure(kind: NoticeServiceKind, at: Date, failure: string): Promise<void> {
    await this.pool.query('UPDATE notification_services SET last_failure = $3, last_failure_at = $2 WHERE kind = $1', [
      kind,
      at,
      failure,
    ]);
  }

  async serviceCounts(): Promise<NoticeServiceCounts[]> {
    const result = await this.pool.query<{ kind: NoticeServiceKind; people: number; failing: number; waiting: number }>(
      `SELECT kinds.kind,
              (SELECT count(*)::int FROM notification_destinations d WHERE d.kind = kinds.kind AND d.enabled)
                AS people,
              (SELECT count(*)::int FROM notification_destinations d
                WHERE d.kind = kinds.kind AND d.enabled AND d.last_error IS NOT NULL)
                AS failing,
              (SELECT count(*)::int FROM notification_deliveries w WHERE w.kind = kinds.kind) AS waiting
         FROM unnest($1::text[]) WITH ORDINALITY AS kinds (kind, place)
        ORDER BY kinds.place`,
      [NOTICE_SERVICE_KINDS],
    );
    return result.rows;
  }

  // -------------------------------------------------------------- one user's own

  async destinations(userId: string): Promise<NoticeDestinationRow[]> {
    if (!USER_ID.test(userId)) return [];
    const result = await this.pool.query<DestinationDbRow>(
      `SELECT ${DESTINATION_COLUMNS}
         FROM notification_destinations
        WHERE user_id = $1
        ORDER BY array_position($2::text[], kind)`,
      [userId, NOTICE_SERVICE_KINDS],
    );
    return result.rows.map(destinationOf);
  }

  /**
   * One transaction: the destination's row is locked while the old address is read, so the save and the drop of what
   * waited for an address it replaces cannot cross another save. The user's topics start here when they have none.
   */
  async saveDestination(
    key: NoticeDestinationKey,
    address: string,
    at: Date,
    startingTopics: readonly NoticeTopic[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query<{ address: string }>(
        'SELECT address FROM notification_destinations WHERE user_id = $1 AND kind = $2 FOR UPDATE',
        [key.userId, key.kind],
      );
      const moved = before.rows[0] !== undefined && before.rows[0].address !== address;
      if (moved) {
        await client.query('DELETE FROM notification_deliveries WHERE user_id = $1 AND kind = $2', [
          key.userId,
          key.kind,
        ]);
      }
      await client.query(
        `INSERT INTO notification_destinations (user_id, kind, address, saved_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind) DO UPDATE
            SET address = EXCLUDED.address,
                saved_at = EXCLUDED.saved_at,
                last_sent_at = CASE WHEN $5 THEN NULL ELSE notification_destinations.last_sent_at END,
                last_error = CASE WHEN $5 THEN NULL ELSE notification_destinations.last_error END,
                last_error_at = CASE WHEN $5 THEN NULL ELSE notification_destinations.last_error_at END,
                last_test_at = CASE WHEN $5 THEN NULL ELSE notification_destinations.last_test_at END,
                last_test_error = CASE WHEN $5 THEN NULL ELSE notification_destinations.last_test_error END`,
        [key.userId, key.kind, address, at, moved],
      );
      await client.query(
        `INSERT INTO notification_choices (user_id, topics, updated_at)
         VALUES ($1, $2::text[], $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [key.userId, [...startingTopics], at],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The switch and, for a switch off, the drop of its waiting notices are one statement. */
  async setDestinationEnabled(key: NoticeDestinationKey, enabled: boolean): Promise<boolean> {
    if (!USER_ID.test(key.userId)) return false;
    const result = await this.pool.query<{ switched: number }>(
      `WITH switched AS (
         UPDATE notification_destinations SET enabled = $3 WHERE user_id = $1 AND kind = $2 RETURNING kind
       ), dropped AS (
         DELETE FROM notification_deliveries
          WHERE user_id = $1 AND kind = $2 AND NOT $3 AND EXISTS (SELECT 1 FROM switched)
       )
       SELECT count(*)::int AS switched FROM switched`,
      [key.userId, key.kind, enabled],
    );
    return result.rows[0]?.switched === 1;
  }

  /** Its waiting notices go with it, by the foreign key's ON DELETE CASCADE. */
  async removeDestination(key: NoticeDestinationKey): Promise<void> {
    if (!USER_ID.test(key.userId)) return;
    await this.pool.query('DELETE FROM notification_destinations WHERE user_id = $1 AND kind = $2', [
      key.userId,
      key.kind,
    ]);
  }

  async topics(userId: string): Promise<NoticeTopic[] | null> {
    if (!USER_ID.test(userId)) return null;
    const result = await this.pool.query<{ topics: string[] }>(
      'SELECT topics FROM notification_choices WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    return row ? storedNoticeTopics(row.topics) : null;
  }

  async saveTopics(userId: string, topics: readonly NoticeTopic[], at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_choices (user_id, topics, updated_at)
       VALUES ($1, $2::text[], $3)
       ON CONFLICT (user_id) DO UPDATE SET topics = EXCLUDED.topics, updated_at = EXCLUDED.updated_at`,
      [userId, storedNoticeTopics(topics), at],
    );
  }

  async waitingCounts(userId: string): Promise<Map<NoticeServiceKind, number>> {
    if (!USER_ID.test(userId)) return new Map();
    const result = await this.pool.query<{ kind: NoticeServiceKind; waiting: number }>(
      `SELECT kind, count(*)::int AS waiting
         FROM notification_deliveries
        WHERE user_id = $1
        GROUP BY kind`,
      [userId],
    );
    return new Map(result.rows.map((row) => [row.kind, row.waiting]));
  }

  async recordSent(key: NoticeDestinationKey, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE notification_destinations
          SET last_sent_at = $3, last_error = NULL, last_error_at = NULL
        WHERE user_id = $1 AND kind = $2`,
      [key.userId, key.kind, at],
    );
  }

  async recordFailed(key: NoticeDestinationKey, at: Date, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_destinations SET last_error = $4, last_error_at = $3 WHERE user_id = $1 AND kind = $2`,
      [key.userId, key.kind, at, error],
    );
  }

  /**
   * One UPDATE that checks the last test's moment and writes the new one: a second request at the same time waits for
   * the first one's row lock, reads the moment it wrote, and claims nothing.
   */
  async claimTest(key: NoticeDestinationKey, at: Date, everySeconds: number): Promise<boolean> {
    if (!USER_ID.test(key.userId)) return false;
    const result = await this.pool.query(
      `UPDATE notification_destinations
          SET last_test_at = $3, last_test_error = NULL
        WHERE user_id = $1 AND kind = $2
          AND (last_test_at IS NULL OR last_test_at <= $3::timestamptz - make_interval(secs => $4))`,
      [key.userId, key.kind, at, everySeconds],
    );
    return result.rowCount === 1;
  }

  async recordTest(key: NoticeDestinationKey, error: string | null): Promise<void> {
    await this.pool.query(
      'UPDATE notification_destinations SET last_test_error = $3 WHERE user_id = $1 AND kind = $2',
      [key.userId, key.kind, error],
    );
  }

  async startChatCode(userId: string, code: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_chat_codes (user_id, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`,
      [userId, code, expiresAt],
    );
  }

  async chatCode(userId: string, now: Date): Promise<string | null> {
    if (!USER_ID.test(userId)) return null;
    const result = await this.pool.query<{ code: string }>(
      'SELECT code FROM notification_chat_codes WHERE user_id = $1 AND expires_at > $2',
      [userId, now],
    );
    return result.rows[0]?.code ?? null;
  }

  // ------------------------------------------- everyone a notice can reach, and the waits

  /**
   * One query over the topics, the destinations that are on and the services that are saved and on, the earliest user
   * first. A user whose ticks hold no topic this code knows reaches nobody, and is left out.
   */
  async recipients(): Promise<NoticeRecipient[]> {
    const result = await this.pool.query<DestinationDbRow & { topics: string[] }>(
      `SELECT d.user_id, d.kind, d.address, d.enabled, d.saved_at, d.last_sent_at, d.last_error, d.last_error_at,
              d.last_test_at, d.last_test_error, c.topics
         FROM notification_choices c
         JOIN users u ON u.id = c.user_id
         JOIN notification_destinations d ON d.user_id = c.user_id AND d.enabled
         JOIN notification_services s ON s.kind = d.kind AND s.enabled
        WHERE cardinality(c.topics) > 0
        ORDER BY u.created_at, u.id, array_position($1::text[], d.kind)`,
      [NOTICE_SERVICE_KINDS],
    );
    const recipients: NoticeRecipient[] = [];
    for (const row of result.rows) {
      const last = recipients.at(-1);
      if (last?.userId === row.user_id) {
        last.destinations.push(destinationOf(row));
        continue;
      }
      const topics = storedNoticeTopics(row.topics);
      if (topics.length === 0) continue;
      recipients.push({ userId: row.user_id, topics, destinations: [destinationOf(row)] });
    }
    return recipients;
  }

  async addWaiting(notices: readonly NewWaitingNotice[]): Promise<void> {
    if (notices.length === 0) return;
    const rows = notices.map((notice) => ({
      user_id: notice.userId,
      kind: notice.kind,
      title: notice.title,
      body: notice.text,
      subjects: notice.subjects,
      raised_at: notice.raisedAt.toISOString(),
      last_error: notice.error,
    }));
    await this.pool.query(
      `INSERT INTO notification_deliveries (user_id, kind, title, body, subjects, raised_at, last_error)
       SELECT user_id, kind, title, body, subjects, raised_at, last_error
         FROM jsonb_to_recordset($1::jsonb)
           AS notice (
             user_id uuid, kind text, title text, body text, subjects text[], raised_at timestamptz, last_error text
           )`,
      [JSON.stringify(rows)],
    );
  }

  async waiting(): Promise<WaitingNoticeRow[]> {
    const result = await this.pool.query<DeliveryDbRow>(
      `SELECT id::text, user_id, kind, title, body, subjects, raised_at, attempts, last_error
         FROM notification_deliveries
        ORDER BY raised_at, id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      title: row.title,
      text: row.body,
      subjects: row.subjects,
      raisedAt: row.raised_at,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
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
