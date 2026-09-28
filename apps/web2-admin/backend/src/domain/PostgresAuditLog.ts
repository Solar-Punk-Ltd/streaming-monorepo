import { Pool } from 'pg';

import type { AuditEntry, AuditLog } from './AuditLog.js';

/**
 * The audit log in Postgres: one INSERT per entry, into `audit_log`
 * (migration 007). Nothing here reads it back; `psql` does, see the README.
 */
export class PostgresAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    const { actor } = entry;
    const actorUserId = actor.kind === 'operator' ? actor.userId : null;
    const actorName = actor.kind === 'operator' ? actor.username : actor.kind === 'system' ? actor.reason : null;

    await this.pool.query(
      `INSERT INTO audit_log
         (actor_kind, actor_user_id, actor_name, action, stream_id, topic,
          status_before, status_after, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        actor.kind,
        actorUserId,
        actorName,
        entry.action,
        entry.streamId ?? null,
        entry.topic ?? null,
        entry.statusBefore ?? null,
        entry.statusAfter ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  }
}
