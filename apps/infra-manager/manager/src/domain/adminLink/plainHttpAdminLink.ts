import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

import {
  DOCKER_HOST_GATEWAY_NAME,
  type PlainHttpAdminLinkVerdict,
  plainHttpAdminLinkHost,
} from '@streaming-infra-manager/common';

import { config } from '../../utils/config.js';

/** Judges a web2 admin link address before the manager saves it or sends its token to it. Never throws. */
export type PlainHttpJudge = (url: string) => Promise<PlainHttpAdminLinkVerdict>;

export interface PlainHttpJudgeDeps {
  /** ADMIN_LINK_ALLOW_PLAIN_HTTP as the config read it. The config's own when left out. */
  allowPlainHttp?: boolean;
  isInContainer?: () => boolean;
  /** Every address a name resolves to from the manager. Throws for a name that does not resolve. */
  lookupAll?: (host: string) => Promise<string[]>;
  /** The manager's own interfaces, which inside its container are the Docker networks it is on. */
  interfaces?: () => readonly { cidr: string | null; internal: boolean }[];
}

/** The ranges that reach this machine alone, whatever the manager runs in. */
const LOOPBACK: readonly [string, number, 'ipv4' | 'ipv6'][] = [
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
];

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

function ownInterfaces(): { cidr: string | null; internal: boolean }[] {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
}

/**
 * Where plain http to the web2 admin link is taken: the loopback, the addresses `host.docker.internal` resolves to,
 * which is the host's bridge, and inside the manager's container every network one of its interfaces is on, which is
 * each Docker network the container joined. Outside a container the manager's interfaces are the host's own, a LAN
 * among them, so none is read. A link-local range is never one.
 */
async function ownNetworks(
  isInContainer: () => boolean,
  lookupAll: (host: string) => Promise<string[]>,
  interfaces: () => readonly { cidr: string | null; internal: boolean }[],
): Promise<BlockList> {
  const own = new BlockList();
  for (const [network, prefix, family] of LOOPBACK) own.addSubnet(network, prefix, family);
  for (const address of await lookupAll(DOCKER_HOST_GATEWAY_NAME).catch(() => [])) {
    own.addAddress(address, familyOf(address));
  }
  if (isInContainer()) {
    for (const { cidr, internal } of interfaces()) {
      if (internal || !cidr) continue;
      const [network = '', prefix = ''] = cidr.split('/');
      if (isIP(network) === 0 || /^fe[89ab]/i.test(network)) continue;
      own.addSubnet(network, Number(prefix), familyOf(network));
    }
  }
  return own;
}

/**
 * The manager's rule for plain http to its web2 admin link. Every push to the link carries the registrar token and
 * each stage's SRT passphrase, so plain http is taken only to an address on the manager's own host or a Docker
 * network of its container: a loopback host and `host.docker.internal` by their text, and any other host by what it
 * resolves to, every address of it. A name that does not resolve is `unresolved`: Docker's own DNS answers no address
 * for a service whose container is not running, so a link to the admin's service on this host reads so while the
 * admin is stopped or redeployed, and is judged again at the next send. https is always taken, and
 * `ADMIN_LINK_ALLOW_PLAIN_HTTP` takes plain http to any host.
 */
export function plainHttpAdminLinkJudge(deps: PlainHttpJudgeDeps = {}): PlainHttpJudge {
  const {
    allowPlainHttp = config.adminLinkAllowPlainHttp,
    isInContainer = () => existsSync('/.dockerenv'),
    lookupAll = async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address),
    interfaces = ownInterfaces,
  } = deps;
  return async (url) => {
    const host = plainHttpAdminLinkHost(url);
    if (host === null) return 'allowed';
    if (allowPlainHttp) return 'allowed-by-setting';
    const addresses = isIP(host) === 0 ? await lookupAll(host).catch(() => []) : [host];
    if (addresses.length === 0) return 'unresolved';
    const own = await ownNetworks(isInContainer, lookupAll, interfaces);
    return addresses.every((address) => own.check(address, familyOf(address))) ? 'allowed' : 'refused';
  };
}

/** The rule as this manager's settings and networks make it, which every save and every send of the link goes by. */
export const judgePlainHttpAdminLink: PlainHttpJudge = plainHttpAdminLinkJudge();
