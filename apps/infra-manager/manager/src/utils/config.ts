import 'dotenv/config';

import { isIP } from 'node:net';

import {
  bzzToPlur,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  rpcEndpointProblem,
  type VersionInfo,
  versionInfo,
} from '@streaming-infra-manager/common';

import { DEFAULT_LOG_LEVEL, isLogLevel, LOG_LEVELS, type LogLevel } from '../domain/Logger.js';
import { parseStackSources, type StackSource } from '../domain/versions/stackSources.js';

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

/**
 * How little a bee node may have in its chequebook before the manager warns
 * when starting an uploader against it, read once at startup.
 *
 * A bad value stops the process rather than falling back to the default: the
 * whole point of the setting is that one number is quoted in that warning and
 * shown in the UI, and quietly using a different one than the operator wrote is
 * worse than not starting.
 */
function chequebookFloorPlur(): bigint {
  const raw = optional('CHEQUEBOOK_FLOOR_BZZ', DEFAULT_CHEQUEBOOK_FLOOR_BZZ);
  const plur = bzzToPlur(raw);
  if (plur === null) {
    throw new Error(`CHEQUEBOOK_FLOOR_BZZ must be a BZZ amount above zero with at most 16 decimal places, got: ${raw}`);
  }
  return plur;
}

/**
 * The chain endpoint this manager offers every Bee node created from the
 * wizard, or null when the operator configured none.
 *
 * A malformed value stops the process rather than being dropped, for the reason
 * the chequebook floor does: a deployment created against a dropped endpoint
 * falls back to the stack's own, a public RPC that answered one node 4568 HTTP
 * 429s in two hours, and nothing anywhere would say it had.
 *
 * Such a URL can carry an API key in its path, so only its host is logged,
 * answered to a browser, or left in the container logs and the deploy output
 * the manager passes on. The node's own container log on the host carries the
 * whole address whatever this does, which is why manager/.env.sample asks for
 * an address that carries no key.
 *
 * Exported so the refusal can be tested without the process exiting.
 */
export function beeRpcEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const problem = rpcEndpointProblem(value);
  if (problem) throw new Error(`BEE_RPC_ENDPOINT: ${problem}`);
  return value;
}

/**
 * How much the manager logs, read once at startup, which the api hands its
 * logger before it logs anything else. Trimmed, in either case, and info when
 * unset.
 *
 * A level the logger does not know stops the process rather than falling back
 * to info, for the reason the chequebook floor does: logging at a level other
 * than the one the operator wrote is how this setting went unnoticed before,
 * when it was read and never applied.
 *
 * Exported so the refusal can be tested without the process exiting.
 */
export function logLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(value)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${raw}`);
  return value;
}

/** One RFC 1123 label: letters, digits and inner hyphens, at most 63 of them. */
const HOST_NAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Whether a value is a host name, RFC 1123 labels joined by dots. The last
 * label is never all digits, as RFC 1123 says, so 10.0.0.256 is refused as a
 * broken address rather than taken as a name.
 */
function isHostName(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  if (!labels.every((label) => HOST_NAME_LABEL.test(label))) return false;
  return !/^\d+$/.test(labels.at(-1) ?? '');
}

/**
 * The host the manager reaches a locally published port on, or null when the
 * operator configured none and src/domain/localHost.ts picks the default.
 *
 * A host name or an IPv4 address and nothing more: no scheme, no path, no
 * port, no spaces. The value is written into the address of every local
 * uploader health read, every local Bee API call and every local pool string,
 * so anything else reads as a node that does not answer. A filesystem path
 * left here once reported every local stage as "uploader unreachable" for a
 * day, with nothing above a debug line saying why. So a malformed value stops
 * the process, for the reason the chequebook floor does.
 *
 * An IPv6 address is refused for now with a message of its own. Those
 * addresses are written as http://<host>:<port> without brackets, so one would
 * pass this check and still make no working address, which is what the check
 * is here to stop.
 *
 * Exported so the refusal can be tested without the process exiting.
 */
export function beeLocalHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isIP(value) === 6) {
    throw new Error(
      `BEE_LOCAL_HOST does not take an IPv6 address yet: the manager writes it into http://<host>:<port> addresses without brackets, got: ${raw}`,
    );
  }
  if (isIP(value) === 0 && !isHostName(value)) {
    throw new Error(
      `BEE_LOCAL_HOST must be a host name or an IPv4 address, with no scheme, path, port or spaces, got: ${raw}`,
    );
  }
  return value;
}

/**
 * Whether the manager's web2 admin link may be plain http to any host, for a test setup. Off by default: the manager
 * then saves and sends plain http only to its own host or a Docker network of its container, since every push carries
 * the registrar token and each stage's SRT passphrase. `true` turns it on, and any value but `true`, `false` or none
 * stops the manager at startup, as a malformed BEE_LOCAL_HOST does.
 *
 * Exported so the refusal can be tested without the process exiting.
 */
export function adminLinkAllowPlainHttp(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`ADMIN_LINK_ALLOW_PLAIN_HTTP must be true or false, got: ${raw}`);
}

/**
 * The build this manager runs, read once at startup from MANAGER_VERSION and MANAGER_COMMIT, which
 * deploy/deploy.sh builds into the api image: the label tools/release/version.mjs named the deployed commit with,
 * and that commit. A label of another shape than version.mjs prints, or a commit that is not 40 lowercase hex
 * digits, is null, and so is either one unset, which the console shows as a development build. A malformed value
 * does not stop the manager, as a malformed setting above does: it names the build, and the deploy has already
 * refused any value of another shape before it built one.
 *
 * Exported so each shape can be tested without the process.
 */
export function managerVersion(label: string | undefined, commit: string | undefined): VersionInfo {
  return versionInfo(label, commit);
}

export interface AppConfig {
  port: number;
  host: string;
  publicHost: string;
  databaseUrl: string;
  /** See `logLevel`. */
  logLevel: LogLevel;
  chequebookFloorPlur: bigint;
  /**
   * Where added stack versions are checked out. A sibling of the data root,
   * outside the tree `deploy/deploy.sh` rsyncs with --delete, and bind-mounted
   * into the api container at this same absolute path.
   */
  stackVersionsRoot: string;
  /** See `beeRpcEndpoint`. Null when the operator configured none. */
  beeRpcEndpoint: string | null;
  /** See `beeLocalHost`. Null when the operator configured none. */
  beeLocalHost: string | null;
  /** See `adminLinkAllowPlainHttp`. */
  adminLinkAllowPlainHttp: boolean;
  /** The repositories stack versions are built from, the first for a new version. See `parseStackSources`. */
  stackSources: readonly StackSource[];
  /** See `managerVersion`. */
  managerVersion: VersionInfo;
}

export const config: AppConfig = {
  port: Number(optional('MANAGER_PORT', '9876')),
  host: optional('MANAGER_HOST', '0.0.0.0'),
  publicHost: optional('PUBLIC_HOST', ''),
  databaseUrl: required('DATABASE_URL'),
  logLevel: logLevel(process.env.LOG_LEVEL),
  chequebookFloorPlur: chequebookFloorPlur(),
  stackVersionsRoot: optional('STACK_VERSIONS_ROOT', '/opt/streaming/streaming-infra-manager-versions'),
  beeRpcEndpoint: beeRpcEndpoint(process.env.BEE_RPC_ENDPOINT),
  beeLocalHost: beeLocalHost(process.env.BEE_LOCAL_HOST),
  adminLinkAllowPlainHttp: adminLinkAllowPlainHttp(process.env.ADMIN_LINK_ALLOW_PLAIN_HTTP),
  stackSources: parseStackSources(process.env.STACK_SOURCES),
  managerVersion: managerVersion(process.env.MANAGER_VERSION, process.env.MANAGER_COMMIT),
};
