/**
 * Whether a Bee node that answers its health can serve this viewer yet: started, connected to peers,
 * and new enough, read from `/health`, `/readiness` and `/peers`.
 *
 * Anything this cannot read, a path a proxy does not serve, a refused request, a body that is not Bee's,
 * is taken as no objection. The health check has already shown a Bee node is there, and turning a
 * working node away on a guess is worse than letting the viewer try it.
 */
import type { BoundedOutcome } from '../../boundedRequest';
import type { NotReadyReason } from '../../provider';

/**
 * The oldest Bee release this viewer works with. 2.3.0 added `GET /soc/{owner}/{id}`, which the viewer
 * reads every feed entry by index through, the player's time markers included.
 * Every other path it reads (`/feeds`, `/chunks`, `/bytes`, `/bzz`) is older.
 */
export const MINIMUM_BEE_VERSION = '2.3.0';

/** Bee answers `/readiness` 400 until every part of it is up. */
const NOT_READY_YET = 400;
/** Bee answers its full API, `/peers` among it, 503 while it is still syncing at start. */
const FULL_API_NOT_ON_YET = 503;

type Release = readonly [number, number, number];

/** The release a Bee version string names, such as `2.8.2-rc1-0a1b2c3d`, or null when it names none. */
function releaseOf(version: string): Release | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlder(release: Release, than: Release): boolean {
  for (let at = 0; at < release.length; at += 1) {
    if (release[at] !== than[at]) {
      return release[at] < than[at];
    }
  }
  return false;
}

const MINIMUM_RELEASE = releaseOf(MINIMUM_BEE_VERSION) as Release;

function jsonOf(body: Uint8Array | null): unknown {
  if (body === null) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function versionOf(health: unknown): string | null {
  const version = (health as { version?: unknown } | null)?.version;
  return typeof version === 'string' ? version : null;
}

function peerCountOf(peers: unknown): number | null {
  const list = (peers as { peers?: unknown } | null)?.peers;
  return Array.isArray(list) ? list.length : null;
}

/** Why the node cannot serve this viewer yet, or null when nothing it said stands in the way. */
export function notReadyReasonOf(
  healthBody: Uint8Array | null,
  readiness: BoundedOutcome,
  peers: BoundedOutcome,
): NotReadyReason | null {
  const version = versionOf(jsonOf(healthBody));
  const release = version === null ? null : releaseOf(version);
  if (version !== null && release !== null && isOlder(release, MINIMUM_RELEASE)) {
    return { kind: 'too-old', version, needed: MINIMUM_BEE_VERSION };
  }
  if (readiness.kind === 'response' && readiness.response.status === NOT_READY_YET) {
    return { kind: 'starting' };
  }
  if (peers.kind !== 'response') {
    return null;
  }
  if (peers.response.status === FULL_API_NOT_ON_YET) {
    return { kind: 'starting' };
  }
  return peers.response.ok && peerCountOf(jsonOf(peers.body)) === 0 ? { kind: 'no-peers' } : null;
}
