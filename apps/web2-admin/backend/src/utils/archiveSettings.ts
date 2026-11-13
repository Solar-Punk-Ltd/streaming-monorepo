import { ARCHIVE_BUY_MIN_DAYS } from '@streaming-monorepo/web2-admin-common';

/**
 * The archive's settings, from the env file. `docs/architecture/web2-admin.md`, "What it keeps", names them. A value
 * that does not parse stops the start with a sentence that names its key.
 */
export interface ArchiveSettings {
  /** `ARCHIVE_PARALLEL_CHUNKS`: chunks read and posted at once, 16 unless set, 1 to 64. */
  parallelChunks: number;
  /**
   * `ARCHIVE_PUSH_WINDOW_CHUNKS`: how far the posts under a quality's tag may run ahead of what Bee has pushed, 2000
   * unless set, 100 to 100000.
   */
  pushWindowChunks: number;
  /**
   * `ARCHIVE_CHEQUEBOOK_FLOOR_BZZ`: under what the catalogue node's chequebook can pay, in BZZ, the job pauses for
   * funds, 0.1 unless set; 0 never pauses. Held as PLUR in decimal digits, so the config stays plain JSON.
   */
  chequebookFloorPlur: string;
  /** `ARCHIVE_TTL_WARNING_DAYS`: under what time left a stamp is worth a warning, 30 unless set, 1 to 365. */
  ttlWarningDays: number;
  /** `ARCHIVE_BUY_DEFAULT_DAYS`: how long a new stamp lasts unless the user says otherwise, 30 unless set, 2 to 3650. */
  buyDefaultDays: number;
}

export const ARCHIVE_PARALLEL_CHUNKS_DEFAULT = 16;
export const ARCHIVE_PUSH_WINDOW_CHUNKS_DEFAULT = 2_000;
export const ARCHIVE_CHEQUEBOOK_FLOOR_BZZ_DEFAULT = '0.1';
export const ARCHIVE_TTL_WARNING_DAYS_DEFAULT = 30;
export const ARCHIVE_BUY_DEFAULT_DAYS_DEFAULT = 30;

const PLUR_DECIMALS = 16;

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? '').trim() || String(fallback);
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) {
    throw new Error(`Env var ${name} must be a whole number from ${min} to ${max}, got: ${raw}`);
  }
  return value;
}

/** A BZZ amount with at most 16 decimals, as PLUR: `0.1` is 10^15. Null for anything else. */
export function bzzToPlur(text: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,16}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(PLUR_DECIMALS, '0'));
  return whole * 10n ** BigInt(PLUR_DECIMALS) + fraction;
}

export function archiveSettingsFrom(env: NodeJS.ProcessEnv): ArchiveSettings {
  const floorName = 'ARCHIVE_CHEQUEBOOK_FLOOR_BZZ';
  const floorRaw = (env[floorName] ?? '').trim() || ARCHIVE_CHEQUEBOOK_FLOOR_BZZ_DEFAULT;
  const floor = bzzToPlur(floorRaw);
  if (floor === null) {
    throw new Error(
      `Env var ${floorName} must be an amount of BZZ such as 0.1, with at most 16 decimals, got: ${floorRaw}`,
    );
  }
  return {
    parallelChunks: wholeNumber(env, 'ARCHIVE_PARALLEL_CHUNKS', ARCHIVE_PARALLEL_CHUNKS_DEFAULT, 1, 64),
    pushWindowChunks: wholeNumber(env, 'ARCHIVE_PUSH_WINDOW_CHUNKS', ARCHIVE_PUSH_WINDOW_CHUNKS_DEFAULT, 100, 100_000),
    chequebookFloorPlur: floor.toString(),
    ttlWarningDays: wholeNumber(env, 'ARCHIVE_TTL_WARNING_DAYS', ARCHIVE_TTL_WARNING_DAYS_DEFAULT, 1, 365),
    buyDefaultDays: wholeNumber(
      env,
      'ARCHIVE_BUY_DEFAULT_DAYS',
      ARCHIVE_BUY_DEFAULT_DAYS_DEFAULT,
      ARCHIVE_BUY_MIN_DAYS,
      3650,
    ),
  };
}
