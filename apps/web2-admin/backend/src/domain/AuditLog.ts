import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../utils/errorUtils.js';

import { describeActor, type Actor } from './actor.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** Every action the audit log knows. Migration 007 stores them as text. */
export type AuditAction =
  | 'stream.create'
  | 'stream.update'
  | 'stream.delete'
  | 'stream.thumbnail.set'
  | 'stream.thumbnail.clear'
  | 'stream.key.rotate'
  | 'stream.publish'
  | 'stream.republish'
  | 'stream.unpublish'
  | 'stream.publish.failed'
  | 'stream.unpublish.failed'
  | 'stream.state.live'
  | 'stream.state.vod'
  | 'stream.rendition.report'
  | 'feed.reconcile'
  | 'stream.publishing.reset'
  | 'user.add'
  | 'user.remove'
  | 'user.sessions.revoke'
  | 'user.password.change';

/**
 * One row of `audit_log`: who did what to which stream, and what it moved.
 *
 * `details` is whatever the action has to say beyond that — the fields an
 * edit changed, the feed index a write landed at and what it published, the
 * error a publish failed with, the user a user action was done to. Never a
 * secret: no publish key, no password or hash, no session token.
 */
export interface AuditEntry {
  actor: Actor;
  action: AuditAction;
  streamId?: string | null;
  topic?: string | null;
  statusBefore?: StreamStatus | null;
  statusAfter?: StreamStatus | null;
  details?: Record<string, unknown> | null;
}

/** Where audit entries go: Postgres in production, memory in the tests. */
export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Records an entry after the mutation it describes has happened, and never
 * fails because of it: the row is already written, so an audit write that
 * throws is logged and the caller carries on. Refusing the operation would not
 * undo it, and answering an error for something that did happen would only
 * make the console retry it.
 */
export async function recordAudit(audit: AuditLog, entry: AuditEntry): Promise<void> {
  try {
    await audit.record(entry);
  } catch (error) {
    logger.error(
      `[Audit] could not record ${entry.action} by ${describeActor(entry.actor)}${
        entry.topic ? ` for topic ${entry.topic}` : ''
      }: ${getErrorMessage(error)}`,
    );
  }
}
