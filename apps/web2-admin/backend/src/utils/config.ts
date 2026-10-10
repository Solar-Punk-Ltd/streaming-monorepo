import 'dotenv/config';

import { PrivateKey } from '@ethersphere/bee-js';
import { ADMIN_API_TOKEN_MIN_LENGTH } from '@streaming-monorepo/contracts';
import type { VersionInfo } from '@streaming-monorepo/web2-admin-common';

import { versionFrom } from './buildVersion.js';
import { getErrorMessage } from './errorUtils.js';
import {
  BRAND_WALLET_SECRET_KEY,
  brandWalletSecretProblem,
  MANAGER_FUNDING_TOKEN_KEY,
  MANAGER_FUNDING_URL_KEY,
  managerFundingBaseUrl,
  managerFundingTokenProblem,
  managerFundingUrlProblem,
} from './fundingSettings.js';

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
 * The registrar token is the manager's only way into the internal API, and it
 * can register a stage and designate the catalogue's batch. A short token would
 * be brute-forceable over a LAN, so the length is enforced here rather than
 * trusted to whoever wrote the .env.
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

/** Where the manager's funding API is and the bearer token it takes, which come together or not at all. */
export interface ManagerFundingSettings {
  /** The manager's address, https or plain http to this host, with no trailing slash: the API's paths go after it. */
  url: string;
  /** The manager's `FUNDING_API_TOKEN`, the same value. Never logged. */
  token: string;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  feedGateway: FeedGatewayKind;
  feedPrivateKey: string;
  feedTopic: string;
  viewerBaseUrl: string;
  /**
   * The registrar token the manager pushes stages with on /api/internal. No uploader is given it, and the uploader's
   * routes refuse it.
   */
  internalApiToken: string;
  /**
   * `CATALOGUE_MOVE_ENABLED`: whether an operator may move the catalogue's history onto another batch from the
   * Stages page. Off unless set, until the move has been tried on a real node (docs/architecture/stages.md).
   */
  catalogueMoveEnabled: boolean;
  /**
   * `BRAND_WALLET_SECRET`: the 32 bytes, as 64 hex characters, the brand wallet's key is encrypted under in the
   * database, or null when it is unset, and then no wallet is created or opened. Never logged.
   */
  brandWalletSecret: string | null;
  /**
   * `MANAGER_FUNDING_URL` and `MANAGER_FUNDING_TOKEN`, or null when neither is set, and then funding is not set up
   * (docs/architecture/funding.md).
   */
  managerFunding: ManagerFundingSettings | null;
  /**
   * `WEB2_ADMIN_VERSION` and `WEB2_ADMIN_COMMIT`: the build this process runs, which deploy/deploy.sh builds into the
   * api image. Signed-in users read it at GET /api/version.
   */
  version: VersionInfo;
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

/** `BRAND_WALLET_SECRET`, or null when it is unset. A value that is not 64 hex characters stops the start. */
function brandWalletSecret(): string | null {
  const value = optional(BRAND_WALLET_SECRET_KEY, '').trim();
  if (value === '') return null;
  const problem = brandWalletSecretProblem(value);
  if (problem) throw new Error(`Env var ${problem}`);
  return value;
}

/**
 * `MANAGER_FUNDING_URL` with `MANAGER_FUNDING_TOKEN`, or null when neither is set. One without the other, an address
 * the funding rules refuse, a token they refuse, or the address without `BRAND_WALLET_SECRET` stops the start, with a
 * sentence that names the keys and never repeats a value. Funding signs every transfer with the brand wallet, so it
 * is not set up without one.
 */
function managerFunding(): ManagerFundingSettings | null {
  const url = optional(MANAGER_FUNDING_URL_KEY, '').trim();
  const token = optional(MANAGER_FUNDING_TOKEN_KEY, '').trim();
  if (url === '') {
    if (token === '') return null;
    throw new Error(
      `Env var ${MANAGER_FUNDING_TOKEN_KEY} is set without ${MANAGER_FUNDING_URL_KEY}: set both to set funding up, or neither`,
    );
  }
  const problem =
    managerFundingUrlProblem(url) ??
    (token === ''
      ? `${MANAGER_FUNDING_TOKEN_KEY} is required with ${MANAGER_FUNDING_URL_KEY}: it is the manager's FUNDING_API_TOKEN`
      : managerFundingTokenProblem(token)) ??
    (optional(BRAND_WALLET_SECRET_KEY, '').trim() === ''
      ? `${BRAND_WALLET_SECRET_KEY} is required with ${MANAGER_FUNDING_URL_KEY}: funding signs every transfer with the brand wallet, whose key is encrypted under it`
      : null);
  if (problem) throw new Error(`Env var ${problem}`);
  return { url: managerFundingBaseUrl(url), token };
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
  brandWalletSecret: brandWalletSecret(),
  managerFunding: managerFunding(),
  version: versionFrom(process.env),
};
