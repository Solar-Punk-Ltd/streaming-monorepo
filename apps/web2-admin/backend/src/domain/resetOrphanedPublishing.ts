import type { StreamRow } from '../types/index.js';

import { describeActor, describeStream, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** The one statement the boot repair needs; a fake stands in for tests. */
export interface OrphanedPublishingStore {
  resetOrphanedPublishing(): Promise<StreamRow[]>;
}

const BOOT: Actor = { kind: 'system', reason: 'boot' };

/**
 * The boot repair of rows a dead process left in `publishing` (see
 * `StreamRepository.resetOrphanedPublishing` for where each goes back to),
 * with a log line and an audit entry per row. Nobody asked for it, so the
 * actor is the process itself.
 */
export async function resetOrphanedPublishing(streams: OrphanedPublishingStore, audit: AuditLog): Promise<StreamRow[]> {
  const reset = await streams.resetOrphanedPublishing();
  for (const row of reset) {
    logger.warn(
      `[Boot] ${describeActor(BOOT)} reset ${describeStream(row)}, stuck in publishing: publishing → ${row.status}`,
    );
    await recordAudit(audit, {
      actor: BOOT,
      action: 'stream.publishing.reset',
      streamId: row.id,
      topic: row.topic,
      statusBefore: 'publishing',
      statusAfter: row.status,
      details: { publishError: row.publish_error },
    });
  }
  return reset;
}
