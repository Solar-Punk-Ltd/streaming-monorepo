import 'dotenv/config';

import { PrivateKey } from '@ethersphere/bee-js';

import { getErrorMessage } from './errorUtils.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Env var ${name} must be a number, got: ${raw}`);
  }
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = optional(name, String(fallback)).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`Env var ${name} must be true or false, got: ${raw}`);
}

/**
 * The internal API is the uploader's only way in, and it can flip a stream to
 * live and rewrite its catalogue entry. A short token would be brute-forceable
 * over a LAN, so the length is enforced here rather than trusted to whoever
 * wrote the .env.
 */
export const INTERNAL_API_TOKEN_MIN_LENGTH = 32;

function requiredSecret(name: string, minLength: number): string {
  const value = required(name).trim();
  if (value.length < minLength) {
    throw new Error(`Env var ${name} must be at least ${minLength} characters, got ${value.length}`);
  }
  return value;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export type FeedGatewayKind = 'bee' | 'fake';

const FEED_GATEWAY_KINDS: readonly FeedGatewayKind[] = ['bee', 'fake'];

export interface IngestConfig {
  host: string;
  srtPort: number;
  rtmpPort: number;
  /** One value for the whole SRS server, or null when SRT is unencrypted. */
  srtPassphrase: string | null;
  keyVerified: boolean;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  feedGateway: FeedGatewayKind;
  beeUrl: string;
  postageBatchId: string;
  feedPrivateKey: string;
  feedTopic: string;
  viewerBaseUrl: string;
  /** Bearer token the uploader presents on /api/internal. */
  internalApiToken: string;
  ingest: IngestConfig;
}

function feedGateway(): FeedGatewayKind {
  const raw = optional('FEED_GATEWAY', 'bee').trim().toLowerCase();
  if (!FEED_GATEWAY_KINDS.includes(raw as FeedGatewayKind)) {
    throw new Error(`Env var FEED_GATEWAY must be one of ${FEED_GATEWAY_KINDS.join(' | ')}, got: ${raw}`);
  }
  return raw as FeedGatewayKind;
}

function feedPrivateKey(): string {
  const value = required('FEED_PRIVATE_KEY');
  if (!PRIVATE_KEY_RE.test(value)) {
    // Checked here, not where bee-js first touches it: a malformed key would
    // otherwise surface as an opaque byte-length error on the first publish.
    throw new Error('Env var FEED_PRIVATE_KEY must be 0x + 64 hex chars');
  }
  try {
    // The regex accepts hex that is not a valid secp256k1 key — all zeroes,
    // for one. Deriving the address now turns bee-js's unattributed "Invalid
    // private key" into a startup error that names the variable.
    new PrivateKey(value).publicKey().address();
  } catch (error) {
    throw new Error(`Env var FEED_PRIVATE_KEY is not a usable secp256k1 private key: ${getErrorMessage(error)}`);
  }
  return value;
}

export const config: AppConfig = {
  port: optionalNumber('WEB2_ADMIN_PORT', 9877),
  host: optional('WEB2_ADMIN_HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  feedGateway: feedGateway(),
  beeUrl: required('BEE_URL'),
  postageBatchId: required('POSTAGE_BATCH_ID'),
  feedPrivateKey: feedPrivateKey(),
  feedTopic: optional('FEED_TOPIC', 'swarm-stream'),
  viewerBaseUrl: optional('VIEWER_BASE_URL', ''),
  internalApiToken: requiredSecret('INTERNAL_API_TOKEN', INTERNAL_API_TOKEN_MIN_LENGTH),
  ingest: {
    host: required('INGEST_HOST'),
    srtPort: optionalNumber('INGEST_SRT_PORT', 10061),
    rtmpPort: optionalNumber('INGEST_RTMP_PORT', 10062),
    srtPassphrase: optional('INGEST_SRT_PASSPHRASE', '') || null,
    keyVerified: optionalBoolean('INGEST_KEY_VERIFIED', false),
  },
};
