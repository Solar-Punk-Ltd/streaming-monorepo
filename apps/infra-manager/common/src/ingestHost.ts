import { STAGE_KINDS, type StageKind, stageIngestSchema } from '@streaming-monorepo/contracts';

/**
 * The public ingest address of a deployment: the address encoders dial, which
 * the web2 admin shows on a stage's OBS panel. The address the manager's ssh
 * dials can be a private one, so it is a setting of its own, `ingest_host` on
 * the deployment (migration 046), and without one it is the host address the
 * manager resolved for the deployment.
 */

/** The longest address the column takes, a DNS name's own limit. */
export const INGEST_HOST_MAX = 253;

/** The sentence the deployment page shows under the field. */
export const INGEST_HOST_HELP = 'The address encoders dial. The address ssh uses can be a private one.';

/**
 * Why this is not an address encoders can dial, or null. The rule is the stage
 * record's own: a host name, an IPv4 address or an IPv6 one in brackets, with no
 * scheme, port, path or credential. Never repeats the value.
 */
export function ingestHostProblem(value: string): string | null {
  if (value.trim() !== value) return 'The ingest address cannot start or end with a space.';
  if (value.length > INGEST_HOST_MAX) return `The ingest address is longer than ${INGEST_HOST_MAX} characters.`;
  if (!stageIngestSchema.shape.host.safeParse(value).success) {
    return 'The ingest address has to be a host name, an IPv4 address or an IPv6 one in brackets, with no scheme, port or path.';
  }
  return isLoopbackIngestHost(value)
    ? 'The ingest address reaches this host alone, and encoders elsewhere cannot dial it. Give an address they reach.'
    : null;
}

/**
 * Whether an address only reaches the machine it is dialled from, or no machine at all: a loopback name or address,
 * or the unspecified one. An encoder elsewhere cannot reach it, so the manager never hands one to the admin as a
 * stage's ingest address.
 */
export function isLoopbackIngestHost(host: string): boolean {
  if (host.trim() === '') return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host.trim()}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  return hostname === '[::1]' || hostname === '[::]' || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(hostname);
}

/** Why a stage has no ingest address the admin may be given, which the manager's log and `GET /stages` say. */
export const NO_PUBLIC_INGEST_HOST =
  "The stage has no public ingest address, only one that reaches this host alone: set the deployment's public ingest address or PUBLIC_HOST.";

/** Every spelling of a deploy target that means the manager's own machine, as `LOCAL_DEPLOY_TARGETS` in the manager reads them. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['', 'localhost', '127.0.0.1', '0.0.0.0', 'native']);

/** What the address is worked out from. */
export interface IngestHostSource {
  /** The deployment's own setting, or null for none. */
  ingest_host?: string | null;
  /** The host the manager resolved for the deployment, with the ssh layer taken away. */
  network_host?: string | null;
}

/**
 * The address encoders dial for this deployment: its own setting, else the host
 * the manager resolved for it, else, for a deployment on the manager's own
 * machine, the manager's public address, `PUBLIC_HOST`.
 */
export function resolvedIngestHost(source: IngestHostSource, publicHost: string): string {
  const own = source.ingest_host?.trim();
  if (own) return own;
  const resolved = (source.network_host ?? '').trim();
  return LOCAL_HOSTS.has(resolved) ? publicHost : resolved;
}

/** Whether a deployment of this kind runs a stream uploader, and so is a stage the web2 admin learns about. */
export function isStageKind(kind: string): kind is StageKind {
  return (STAGE_KINDS as readonly string[]).includes(kind);
}
