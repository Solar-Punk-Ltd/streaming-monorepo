import { ADMIN_API_TOKEN_KEY, ADMIN_API_URL_KEY, sameAdminOrigin } from './adminLink.js';
import { isLoopbackIngestHost } from './ingestHost.js';
import { settingValueProblem } from './settingValues.js';
import { stackSettingFieldProblem } from './stackSettingFields.js';

/**
 * The web2 admin link every new uploader deployment starts with, set once for
 * the whole manager on its Manager settings page. It applies to deployments
 * created after it is set and never to one that exists, which keeps what it
 * was created with in its own settings.
 */

/** What `GET /manager-settings/admin-link` answers. The token is never answered, only whether one is stored. */
export interface ManagerAdminLink {
  /** The admin's address, or null for no default, which starts new deployments standalone. */
  url: string | null;
  tokenStored: boolean;
  /** The revision a save names. A save is refused once another one has moved past it. */
  revision: number;
}

/**
 * The address the manager generates a deployment's own `ADMIN_API_TOKEN` for: its link's, when the link has an
 * address and a token to register the deployment's stage with, which is how the admin learns the new token's
 * sha256. Null otherwise. Only a deployment that runs a stream uploader, and whose uploader is given an address on
 * this one's origin, is given a token of its own.
 */
export function ownAdminTokenAddressOf(
  link: Pick<ManagerAdminLink, 'url' | 'tokenStored'> | null | undefined,
): string | null {
  return link?.url && link.tokenStored ? link.url : null;
}

/** What `POST /profiles/:name/admin-token/rotate` answers: the sentence the deployment page shows. */
export interface AdminTokenRotateAnswer {
  message: string;
}

/** The sentence a rotation answers with. */
export const ADMIN_TOKEN_ROTATED_MESSAGE =
  "The uploader's admin token is cleared. Redeploy to give the uploader a new one: the deploy generates it and tells the web2 admin its sha256 before the uploader starts. Until then the web2 admin stops taking the old token once the manager next pushes the stage.";

/** What `PUT /manager-settings/admin-link` takes. */
export interface ManagerAdminLinkSave {
  expectedRevision: number;
  /** The admin's address, or empty for no default, which takes the stored token with it. */
  url: string;
  /** Left out keeps the stored token, null clears it, and a value replaces it. */
  token?: string | null;
}

/** Why this key cannot hold this value as a deployment's settings would take it, or null. Never repeats the value. */
function keyValueProblem(key: string, value: string): string | null {
  const envProblem = settingValueProblem(key, value);
  return envProblem ? `${key} ${envProblem}` : stackSettingFieldProblem(key, value);
}

/** Why a new deployment's `ADMIN_API_URL` could not be this address, or null. */
export function adminUrlProblem(url: string): string | null {
  return keyValueProblem(ADMIN_API_URL_KEY, url);
}

/** The name Docker maps to the host's gateway inside a container, which manager/docker-compose.yml sets for the api. */
export const DOCKER_HOST_GATEWAY_NAME = 'host.docker.internal';

/** The manager setting that lets its link take plain http to any host, for a test setup. Off unless it is `true`. */
export const ADMIN_LINK_ALLOW_PLAIN_HTTP_KEY = 'ADMIN_LINK_ALLOW_PLAIN_HTTP';

/**
 * What the manager judged of a link address: `allowed` for https and plain http to the manager's own host or its
 * Docker networks, `allowed-by-setting` for plain http elsewhere while `ADMIN_LINK_ALLOW_PLAIN_HTTP` is on,
 * `refused` for plain http elsewhere, which the manager neither saves nor sends to, and `unresolved` for a name that
 * does not resolve from the manager now. Docker's own DNS answers no address for a service whose container is not
 * running, so such a name is saved, and nothing is sent to it until it resolves and is judged.
 */
export type PlainHttpAdminLinkVerdict = 'allowed' | 'allowed-by-setting' | 'refused' | 'unresolved';

/** Why a save of an address in plain http to another host than the manager's own is refused. Names no address. */
export const PLAIN_HTTP_ADMIN_LINK_REFUSED = `This address is plain http to another host than the manager's own. Every push to it would carry the stored token and each stage's SRT passphrase in clear, so give the https address the edge serves the web2 admin on. Plain http is taken only to the manager's own host or a Docker network of its container, or to any host once ${ADMIN_LINK_ALLOW_PLAIN_HTTP_KEY}=true is set on the manager, for a test setup.`;

/**
 * The host of a link address in plain http whose text does not place it on the manager's own host, which the manager
 * then judges by what it resolves to, or null: for https, for a loopback host (`localhost`, `127.0.0.0/8`, `0.0.0.0`,
 * `[::1]`), for `host.docker.internal`, and for an address that is no URL, which the address rules refuse on their own.
 * The text alone cannot tell a Docker service name on the manager's host from another host's name, so a page never
 * judges one. An IPv6 host comes without its brackets.
 */
export function plainHttpAdminLinkHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || isLoopbackIngestHost(parsed.host)) return null;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  return host === DOCKER_HOST_GATEWAY_NAME ? null : host;
}

/** Why a new deployment's `ADMIN_API_TOKEN` could not be this token, or null. */
export function adminTokenProblem(token: string): string | null {
  return keyValueProblem(ADMIN_API_TOKEN_KEY, token);
}

/** The link a save lands on: its address, or null for none, and whether it stores a token. */
export type StoredManagerAdminLink = Pick<ManagerAdminLink, 'url' | 'tokenStored'>;

/**
 * Why a save of the manager's link would be refused, one sentence each, or
 * none. The address and the token answer to the rules a deployment's own
 * `ADMIN_API_URL` and `ADMIN_API_TOKEN` do, because that is where a new
 * deployment gets them, and no sentence repeats either. An address on
 * another origin than the stored link's has to come with a new token or a
 * cleared one, because the stored token goes only to the address it was saved
 * with. An address in plain http is refused where the manager judged it to go to
 * another host than its own, which only the manager can judge.
 */
export function managerAdminLinkProblems(
  { url, token }: ManagerAdminLinkSave,
  stored?: StoredManagerAdminLink,
  plainHttp: PlainHttpAdminLinkVerdict = 'allowed',
): string[] {
  const problems: string[] = [];
  const urlProblem = url === '' ? null : adminUrlProblem(url);
  if (urlProblem) problems.push(urlProblem);
  else if (url !== '' && plainHttp === 'refused') problems.push(PLAIN_HTTP_ADMIN_LINK_REFUSED);
  if (stored?.tokenStored && url !== '' && token === undefined && !sameAdminOrigin(url, stored.url ?? '')) {
    problems.push(
      'The address moves to another one than the stored token was saved with, and the manager sends its stored token only to the address it was saved with. Type the token again for the new address, or clear it.',
    );
  }
  if (typeof token === 'string') {
    const tokenProblem =
      url === ''
        ? "A token needs the admin's address. Give the address, or leave the token out."
        : token === ''
          ? 'The token cannot be empty. Leave it out to keep the stored one, or clear it.'
          : adminTokenProblem(token);
    if (tokenProblem) problems.push(tokenProblem);
  }
  return problems;
}
