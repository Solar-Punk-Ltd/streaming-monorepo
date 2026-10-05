/**
 * The rules of the admin's funding settings (docs/architecture/funding.md): the secret the brand wallet's key is
 * encrypted under, where the manager's funding API is, and the bearer token it takes. The config refuses a value that
 * breaks one at boot, and the brand wallet and the manager funding client check what they are given against the same
 * rules. Each rule answers a sentence that names the key and never the value, or null.
 */

export const BRAND_WALLET_SECRET_KEY = 'BRAND_WALLET_SECRET';
export const MANAGER_FUNDING_URL_KEY = 'MANAGER_FUNDING_URL';
export const MANAGER_FUNDING_TOKEN_KEY = 'MANAGER_FUNDING_TOKEN';

/** The fewest characters the funding token may have: the manager's own floor for its `FUNDING_API_TOKEN`. */
export const MANAGER_FUNDING_TOKEN_MIN_LENGTH = 32;

/** The name Docker maps to the host inside a container. The deploy compose file maps it for the api. */
export const DOCKER_HOST_GATEWAY_NAME = 'host.docker.internal';

/** 32 bytes as hex, and nothing else: no `0x`, no space. */
const SECRET_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Printable ASCII with no space, which an HTTP header carries as it is. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/** 127.0.0.0/8, as the URL parser writes an IPv4 address. */
const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * A host name of one label, as the URL parser leaves it: lower case, no dot. Only a Docker network's own DNS answers
 * such a name, for a service beside the admin, such as `manager`. An IPv6 address keeps its brackets and a numeric
 * name becomes a dotted IPv4 address, so neither matches.
 */
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Why this cannot be `BRAND_WALLET_SECRET`, or null. */
export function brandWalletSecretProblem(value: string): string | null {
  return SECRET_PATTERN.test(value)
    ? null
    : `${BRAND_WALLET_SECRET_KEY} must be 64 hex characters (32 bytes), or unset for no brand wallet`;
}

/**
 * Whether plain http to this host stays on the admin's own machine: a loopback address, the Docker host's gateway,
 * or a Docker service name. The text alone decides; nothing is resolved.
 */
function isOwnHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === DOCKER_HOST_GATEWAY_NAME ||
    LOOPBACK_IPV4_PATTERN.test(hostname) ||
    SERVICE_NAME_PATTERN.test(hostname)
  );
}

/**
 * Why this cannot be `MANAGER_FUNDING_URL`, or null. Every request to it carries the funding token, so it is https,
 * or plain http only to this host, the rule the manager holds its web2 admin link to: a loopback address,
 * `host.docker.internal`, or a Docker service name with no dot. It carries no user name or password, the token being
 * its one credential, and no `?` or `#` part, since the API's paths are added after it.
 */
export function managerFundingUrlProblem(value: string): string | null {
  const notAnAddress = `${MANAGER_FUNDING_URL_KEY} must be an http or https address, such as https://manager.example.org`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return notAnAddress;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') return notAnAddress;
  if (url.username !== '' || url.password !== '') {
    return `${MANAGER_FUNDING_URL_KEY} cannot carry a user name or a password: the funding token is the one credential the manager takes`;
  }
  // The raw text, since `search` and `hash` are empty for a bare trailing ? or #.
  if (value.includes('?') || value.includes('#')) {
    return `${MANAGER_FUNDING_URL_KEY} cannot carry a ? or # part, because the funding API's paths are added after it`;
  }
  if (url.protocol === 'http:' && !isOwnHost(url.hostname)) {
    return `${MANAGER_FUNDING_URL_KEY} is plain http to another host, and every request carries the funding token: give the manager's https address. Plain http is taken only to this host: a loopback address, ${DOCKER_HOST_GATEWAY_NAME}, or a Docker service name with no dot`;
  }
  return null;
}

/**
 * The address the API's paths are added to: the origin and any path, without a trailing slash. Only for an address
 * {@link managerFundingUrlProblem} takes.
 */
export function managerFundingBaseUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Why this cannot be `MANAGER_FUNDING_TOKEN`, or null. It is the manager's `FUNDING_API_TOKEN`, the same value. */
export function managerFundingTokenProblem(value: string): string | null {
  if (value.length < MANAGER_FUNDING_TOKEN_MIN_LENGTH) {
    return `${MANAGER_FUNDING_TOKEN_KEY} must be at least ${MANAGER_FUNDING_TOKEN_MIN_LENGTH} characters, got ${value.length}`;
  }
  if (!TOKEN_PATTERN.test(value)) {
    return `${MANAGER_FUNDING_TOKEN_KEY} must be printable ASCII with no space inside, since it travels in an HTTP header`;
  }
  return null;
}
