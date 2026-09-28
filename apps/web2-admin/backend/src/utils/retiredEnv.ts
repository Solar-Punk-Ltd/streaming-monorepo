/**
 * Env keys the admin read once and reads no more. Each stream's OBS details
 * come from the stage it is broadcast on, as the manager pushed it
 * (docs/architecture/stages.md), and every uploader that takes streams from
 * this admin verifies the per-stream `key=`. The catalogue is written through
 * the catalogue node and batch the manager designates, so `BEE_URL` and
 * `POSTAGE_BATCH_ID` went too. An env file that still sets them starts as it
 * did; the boot log names them.
 */
export const RETIRED_ENV_KEYS = [
  'INGEST_HOST',
  'INGEST_SRT_PORT',
  'INGEST_RTMP_PORT',
  'INGEST_RTMP_PUBLIC',
  'INGEST_SRT_PASSPHRASE',
  'INGEST_KEY_VERIFIED',
  'BEE_URL',
  'POSTAGE_BATCH_ID',
] as const;

/** The retired keys this environment still sets to something. */
export function retiredEnvKeysSet(env: NodeJS.ProcessEnv = process.env): string[] {
  return RETIRED_ENV_KEYS.filter((key) => (env[key] ?? '').trim() !== '');
}
