import fs from 'fs';
import path from 'path';

import { Logger } from './Logger.js';

/** A Swarm reference as this uploader names a recording it uploaded: 64 lowercase hex digits. */
const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;

/** Topic name to the reference of the newest recording a session on that topic uploaded. */
type PersistedRecordings = Record<string, string>;

/**
 * The newest recording each topic's sessions finished with, so the next session on that topic can
 * open its own recording with it.
 *
 * A live window is a live playlist and never a recording, so the media a topic already carries is not
 * on Swarm at any address a new session can derive. This is where a finished session leaves it: one
 * reference per topic, the newest winning, which is itself a glued recording, so chaining carries
 * every earlier session too.
 *
 * Held in memory and, given a file, written through to it, so the glue survives a restart of this
 * process between two broadcasts on one topic. A file that cannot be read or written costs the next
 * broadcast its prefix and nothing else, so neither failure is ever thrown into a broadcast.
 */
export class RecordingStore {
  private logger = Logger.getInstance();
  private saveFailedAt: number | null = null;
  private recordings: Map<string, string> | null = null;

  /** @param filePath where the references are kept across restarts, or none to keep them in memory. */
  constructor(private readonly filePath?: string) {}

  /** How long the file has been failing to update, or null when the last save landed. */
  public getMsSinceSaveFailed(): number | null {
    return this.saveFailedAt === null ? null : Date.now() - this.saveFailedAt;
  }

  /** The reference of the newest recording finished on `topic`, or null when none is known. */
  public recordingOf(topic: string): string | null {
    return this.loaded().get(topic) ?? null;
  }

  public remember(topic: string, reference: string): void {
    const recordings = this.loaded();
    recordings.set(topic, reference);
    this.write(recordings);
  }

  private loaded(): Map<string, string> {
    this.recordings ??= this.read();
    return this.recordings;
  }

  /** What is on disk, or nothing for a file that is absent or damaged. Entries that are not a reference are dropped. */
  private read(): Map<string, string> {
    const recordings = new Map<string, string>();
    if (this.filePath === undefined) {
      return recordings;
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        return recordings;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.error(`[RecordingStore] ${this.filePath} does not hold a recording mapping, so it is ignored`);
        return recordings;
      }
      for (const [topic, reference] of Object.entries(parsed)) {
        if (typeof reference === 'string' && REFERENCE_PATTERN.test(reference)) {
          recordings.set(topic, reference);
        }
      }
    } catch (error) {
      this.logger.error(`[RecordingStore] Failed to load ${this.filePath}:`, error);
    }
    return recordings;
  }

  private write(recordings: ReadonlyMap<string, string>): void {
    if (this.filePath === undefined) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const data: PersistedRecordings = Object.fromEntries(recordings);
      fs.writeFileSync(tmpPath, JSON.stringify(data));
      fs.renameSync(tmpPath, this.filePath);
      this.saveFailedAt = null;
    } catch (error) {
      this.saveFailedAt ??= Date.now();
      this.logger.error(`[RecordingStore] Failed to save ${this.filePath}:`, error);
    }
  }
}
