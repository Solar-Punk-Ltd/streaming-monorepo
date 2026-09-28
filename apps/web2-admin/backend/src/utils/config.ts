import 'dotenv/config';

import { PrivateKey } from '@ethersphere/bee-js';
import { ADMIN_API_TOKEN_MIN_LENGTH } from '@streaming-monorepo/contracts';

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

/**
 * The internal API is the uploader's only way in, and it can flip a stream to
 * live and rewrite its catalogue entry. A short token would be brute-forceable
 * over a LAN, so the length is enforced here rather than trusted to whoever
 * wrote the .env.
 */
export const INTERNAL_API_TOKEN_MIN_LENGTH = ADMIN_API_TOKEN_MIN_LENGTH;

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

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  feedGateway: FeedGatewayKind;
  feedPrivateKey: string;
  feedTopic: string;
  viewerBaseUrl: string;
  /** Bearer token the uploader presents on /api/internal. */
  internalApiToken: string;
  /**
   * `CATALOGUE_MOVE_ENABLED`: whether an operator may move the catalogue's history onto another batch from the
   * Stages page. Off unless set, until the move has been tried on a real node (docs/architecture/stages.md).
   */
  catalogueMoveEnabled: boolean;
}

function optionalFlag(name: string): boolean {
  const raw = optional(name, 'false').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Env var ${name} must be true or false, got: ${raw}`);
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
    throw new Error(`Env var FEED_PRIVATE_KEY is not a usable secp256k1 private key: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  return value;
}

export const config: AppConfig = {
  port: optionalNumber('WEB2_ADMIN_PORT', 9877),
  host: optional('WEB2_ADMIN_HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  feedGateway: feedGateway(),
  feedPrivateKey: feedPrivateKey(),
  feedTopic: optional('FEED_TOPIC', 'swarm-stream'),
  viewerBaseUrl: optional('VIEWER_BASE_URL', ''),
  internalApiToken: requiredSecret('INTERNAL_API_TOKEN', INTERNAL_API_TOKEN_MIN_LENGTH),
  catalogueMoveEnabled: optionalFlag('CATALOGUE_MOVE_ENABLED'),
};
