/**
 * Which network an address is on, as browsers sort them for local network access: this computer, the
 * local network, or the internet. Chrome, Edge and Firefox ask the viewer before a site reaches a more
 * private one, and Chrome lets an https page reach a plain http node only on the local network.
 *
 * Read from the address as written, never from where its name resolves, because the page cannot see
 * that. A name such as `bee.lan` that resolves to a home router's address is therefore the internet
 * here, and the picker asks for its https address or its IP address instead.
 */

/** The values of the Local Network Access draft's `IPAddressSpace`, which `fetch` takes as `targetAddressSpace`. */
export type AddressSpace = 'loopback' | 'local' | 'public';

/** `RequestInit` with the Local Network Access draft's option, which the DOM types do not carry yet. */
type LocalNetworkRequestInit = RequestInit & { targetAddressSpace?: 'local' };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Space(hostname: string): AddressSpace | null {
  const match = IPV4.exec(hostname);
  if (!match) {
    return null;
  }
  const [first, second] = [Number(match[1]), Number(match[2])];
  if (first === 127) {
    return 'loopback';
  }
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return 'local';
  }
  return 'public';
}

/** An IPv6 literal as `URL` writes it, in brackets and lower case. Unique local addresses are fc00::/7. */
function ipv6Space(hostname: string): AddressSpace | null {
  if (!hostname.startsWith('[')) {
    return null;
  }
  if (hostname === '[::1]') {
    return 'loopback';
  }
  return /^\[f[cd]/.test(hostname) ? 'local' : 'public';
}

/** Where an address points, or null for a path on this site, such as `/bee`, which is this page's own origin. */
export function addressSpaceOf(url: string): AddressSpace | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'loopback';
  }
  if (hostname.endsWith('.local')) {
    return 'local';
  }
  return ipv4Space(hostname) ?? ipv6Space(hostname) ?? 'public';
}

/**
 * The draft's option that marks a plain http request as meant for the local network, which the draft
 * needs before an https page may make it to a name it cannot place. Chrome 152 places a private IP
 * address and a `.local` name by itself and ignores the option, so it is sent for a browser that reads
 * it and changes nothing where none does. Only for such a request: the draft fails a request whose mark
 * does not match where the address really is, and a loopback or https address needs none.
 */
export function localNetworkRequestInit(url: string): LocalNetworkRequestInit {
  return url.startsWith('http://') && addressSpaceOf(url) === 'local' ? { targetAddressSpace: 'local' } : {};
}

/** Asks the browser about one permission by name, as `navigator.permissions.query` does. */
type PermissionQuery = (descriptor: { name: string }) => Promise<unknown>;

/**
 * The names Chrome and the draft give the Local Network Access permission. Chrome 152 knows all three,
 * while a browser without Local Network Access rejects each as a name it does not have.
 */
const LOCAL_NETWORK_PERMISSION_NAMES = ['local-network-access', 'local-network', 'loopback-network'];

/** The page's Permissions API, or undefined where there is none. */
function pagePermissionQuery(): PermissionQuery | undefined {
  if (typeof navigator === 'undefined' || navigator.permissions === undefined) {
    return undefined;
  }
  const { permissions } = navigator;
  return (descriptor) => permissions.query(descriptor as unknown as PermissionDescriptor);
}

/**
 * Whether the browser behind `query` implements Local Network Access, which is also what lets an https
 * page reach a plain http node on the local network.
 *
 * Read off the Permissions API, because that is the part of the draft Chrome exposes: Chrome 152 has no
 * `targetAddressSpace` on `Request` and never reads it from a request's options, yet answers a query
 * for the permission. Without one it still exempts a private IP address and a `.local` name from the
 * mixed content block, which are the only plain http addresses the picker lets through.
 */
export async function detectLocalNetworkAccess(
  query: PermissionQuery | undefined = pagePermissionQuery(),
): Promise<boolean> {
  if (query === undefined) {
    return false;
  }
  for (const name of LOCAL_NETWORK_PERMISSION_NAMES) {
    try {
      await query({ name });
      return true;
    } catch {
      // A name this browser does not know. The next one may be the one it ships.
    }
  }
  return false;
}

let localNetworkAccess: Promise<boolean> | undefined;

/** {@link detectLocalNetworkAccess} for this page, asked once, since a browser does not gain it while a page is open. */
export function supportsLocalNetworkRequests(): Promise<boolean> {
  localNetworkAccess ??= detectLocalNetworkAccess();
  return localNetworkAccess;
}
