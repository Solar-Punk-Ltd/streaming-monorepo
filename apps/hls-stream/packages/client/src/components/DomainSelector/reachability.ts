/**
 * Why a Bee node of the viewer's own could not be reached, as far as a page can tell.
 *
 * A browser reports a closed port, a node that refuses this site's origin and its own refusal of the
 * local network the same way, as a fetch that rejects with no status. The provider's probe already
 * tells a CORS refusal apart, by a second request without CORS. What is left is whether the browser
 * stopped the request, which the Permissions API answers for the browsers with Local Network Access.
 */
import { type AddressSpace, addressSpaceOf, supportsLocalNetworkRequests } from '@/swarm/addressSpace';
import type { ProbeResult } from '@/swarm/provider';

export type UnreachableCause =
  /** Nothing answered, and nothing suggests the browser stopped the request. */
  | { readonly kind: 'unreachable' }
  /** Something answered, and did not allow this site to read its answer. */
  | { readonly kind: 'cors-refused' }
  /** The browser says the viewer refused this site the local network. */
  | { readonly kind: 'local-network-refused' }
  /** Nothing answered, and the browser may be waiting on, or have been refused, its local network question. */
  | { readonly kind: 'unreachable-local' };

/** A permission's state as the Permissions API gives it, or unknown where the browser does not know the name. */
type PermissionAnswer = PermissionState | 'unknown';

export interface ReachabilityOptions {
  /** The page's own address, whose network decides whether reaching the node needs the viewer's leave. */
  readonly pageUrl?: string;
  /** Whether this browser has Local Network Access. Read from the page when absent. */
  readonly localNetworkRequests?: boolean;
  /** Asks the browser one permission by name. The Permissions API when absent. */
  readonly permission?: (name: string) => Promise<PermissionAnswer>;
}

/**
 * The names a browser may know the permission by, the draft's first. Chrome shipped one permission
 * for both networks as `local-network-access`, which the draft keeps as an alias.
 */
const PERMISSION_NAMES: Readonly<Record<Exclude<AddressSpace, 'public'>, readonly string[]>> = {
  local: ['local-network', 'local-network-access'],
  loopback: ['loopback-network', 'local-network-access'],
};

const PRIVACY: Readonly<Record<AddressSpace, number>> = { public: 0, local: 1, loopback: 2 };

async function askPermissionsApi(name: string): Promise<PermissionAnswer> {
  try {
    const status = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
    return status.state;
  } catch {
    return 'unknown';
  }
}

function currentPageUrl(): string {
  return typeof location === 'undefined' ? '' : location.href;
}

/** The first answer of the names the browser knows, or unknown when it knows none of them. */
async function permissionFor(
  space: Exclude<AddressSpace, 'public'>,
  permission: (name: string) => Promise<PermissionAnswer>,
): Promise<PermissionAnswer> {
  for (const name of PERMISSION_NAMES[space]) {
    const answer = await permission(name);
    if (answer !== 'unknown') {
      return answer;
    }
  }
  return 'unknown';
}

/**
 * The network of the node when reaching it from this page needs the viewer's leave, or null when the
 * browser has no Local Network Access or the node is no more private than the page.
 */
async function guardedSpace(
  baseUrl: string,
  options: ReachabilityOptions,
): Promise<Exclude<AddressSpace, 'public'> | null> {
  const localNetworkRequests = options.localNetworkRequests ?? (await supportsLocalNetworkRequests());
  const target = addressSpaceOf(baseUrl);
  const page = addressSpaceOf(options.pageUrl ?? currentPageUrl()) ?? 'public';
  if (!localNetworkRequests || target === null || target === 'public' || PRIVACY[target] <= PRIVACY[page]) {
    return null;
  }
  return target;
}

/**
 * Whether the browser has yet to ask the viewer about reaching this node. Chrome holds the request
 * while it asks, so a node behind an unanswered question looks like one that went quiet.
 */
export async function awaitsLocalNetworkAnswer(baseUrl: string, options: ReachabilityOptions = {}): Promise<boolean> {
  const space = await guardedSpace(baseUrl, options);
  return space !== null && (await permissionFor(space, options.permission ?? askPermissionsApi)) === 'prompt';
}

/**
 * Why a probe that found nothing readable found it. Never rejects. A node that answered and refused
 * this site is named by the probe itself, and an address that answered nothing is asked about the
 * browser's local network permission when reaching it needs one.
 */
export async function unreachableCause(
  baseUrl: string,
  found: Extract<ProbeResult, { kind: 'unreachable' | 'refuses-this-site' }>,
  options: ReachabilityOptions = {},
): Promise<UnreachableCause> {
  if (found.kind === 'refuses-this-site') {
    return { kind: 'cors-refused' };
  }
  const space = await guardedSpace(baseUrl, options);
  if (space === null) {
    return { kind: 'unreachable' };
  }
  switch (await permissionFor(space, options.permission ?? askPermissionsApi)) {
    case 'denied':
      return { kind: 'local-network-refused' };
    case 'granted':
      return { kind: 'unreachable' };
    case 'prompt':
    case 'unknown':
      return { kind: 'unreachable-local' };
  }
}
