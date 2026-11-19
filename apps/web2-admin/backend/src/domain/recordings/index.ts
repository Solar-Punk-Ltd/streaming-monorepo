import {
  EXPORT_ACTIVE_STATES,
  type ArchiveJobSummary,
  type ExportSummary,
} from '@streaming-monorepo/web2-admin-common';
import type { Pool } from 'pg';

import type { AuditLog } from '../AuditLog.js';

import { RecordingCheckRepository } from './RecordingCheckRepository.js';
import {
  RecordingCheckService,
  type LostRecordingsCatalogueWrite,
  type RecordingJobs,
  type RecordingRenditions,
  type RecordingsCatalogue,
  type RecordingStreams,
} from './RecordingCheckService.js';
import { BeeRecordingReads } from './recordingReads.js';

export { RecordingCheckService, RecordingsRefusedError } from './RecordingCheckService.js';

/** The one export on the server: ExportService. */
export interface RecordingExports {
  current(userId: string | null): Promise<ExportSummary | null>;
}

/** The one archive on the server: ArchiveService. */
export interface RecordingArchives {
  current(userId: string | null): Promise<ArchiveJobSummary | null>;
}

/**
 * The export and the archive as the check reads them. An export is under way until it is done; a done one keeps its
 * file on the server. An archive is under way until it is done, a paused one or one waiting for its stamp included,
 * since it still reads the recording when it goes on.
 */
export function recordingJobsOf(exports: RecordingExports, archives: RecordingArchives | null): RecordingJobs {
  return {
    async openJobStreams() {
      const open = new Set<string>();
      const exporting = await exports.current(null);
      if (exporting && EXPORT_ACTIVE_STATES.includes(exporting.state)) open.add(exporting.streamId);
      const archiving = archives ? await archives.current(null) : null;
      if (archiving && archiving.state !== 'done') open.add(archiving.streamId);
      return open;
    },
    async exportFileStreams() {
      const exporting = await exports.current(null);
      return new Set(exporting?.state === 'done' ? [exporting.streamId] : []);
    },
  };
}

/** What `createRecordings` is built from: the pool, the services of the admin it reads, and the restart window. */
export interface RecordingsWiring {
  pool: Pool;
  /** StreamRepository. */
  streams: RecordingStreams;
  /** StreamRenditionRepository. */
  renditions: RecordingRenditions;
  /** CatalogueBatchService: the node the recordings are read through, and whether the catalogue can be written. */
  catalogue: RecordingsCatalogue;
  /** PublishService: the removal's one catalogue write. */
  publish: LostRecordingsCatalogueWrite;
  /** ExportService. */
  exports: RecordingExports;
  /** ArchiveService, or null on an installation that has none. */
  archives: RecordingArchives | null;
  audit: AuditLog;
  /** `STREAM_RESTART_WINDOW_MINUTES`, as the stream list presents every stream's window with. */
  restartWindowMinutes: number;
}

/**
 * The check of the recordings and the removal of the lost ones, read through the catalogue node with Bee, kept in
 * Postgres (migration 031). Boot it once the export and the archive have booted, and shut it down before the
 * database closes.
 */
export function createRecordings(wiring: RecordingsWiring): RecordingCheckService {
  return new RecordingCheckService(
    {
      store: new RecordingCheckRepository(wiring.pool),
      streams: wiring.streams,
      renditions: wiring.renditions,
      jobs: recordingJobsOf(wiring.exports, wiring.archives),
      catalogue: wiring.catalogue,
      writer: wiring.publish,
      reads: new BeeRecordingReads(),
      audit: wiring.audit,
    },
    { restartWindowMinutes: wiring.restartWindowMinutes },
  );
}
