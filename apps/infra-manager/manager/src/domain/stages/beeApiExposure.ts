/**
 * Whether Docker publishes a Bee node's API on every address of its host, from the fields of the node container's
 * inspect that say it: `NetworkSettings.Ports`, `HostConfig.NetworkMode` and `Config.Cmd`, the same ones
 * `chequebook/DockerBeeBinding.ts` reads for a chequebook session.
 *
 * Bee's API asks for no password, so one published on every address is open to whoever reaches the host. This reads
 * Docker's own record of the published port rather than probing the host's public address: hairpin NAT answers that
 * probe from inside, and a provider firewall in front of the host is invisible from there.
 */

/** The projection of a container inspect this reads. */
export interface BeeApiInspect {
  ports: unknown;
  networkMode: unknown;
  cmd: unknown;
}

const EVERY_ADDRESS = new Set(['', '0.0.0.0', '::', '[::]']);

const API_ADDR_FLAG = '--api-addr';

/**
 * The address part of the last `--api-addr` the node was started with, `:1633` when it names none, which is Bee's
 * own default and every address. Bee's flag parser takes the flag as one word with `=` or as two words, and the last
 * occurrence wins, as `nodeChainEndpoint` reads the chain flag.
 */
function apiAddrHost(cmd: unknown): string | null {
  if (!Array.isArray(cmd)) return null;
  let addr = ':1633';
  for (let index = 0; index < cmd.length; index++) {
    const word = cmd[index];
    if (typeof word !== 'string') continue;
    if (word.startsWith(`${API_ADDR_FLAG}=`)) addr = word.slice(API_ADDR_FLAG.length + 1);
    else if (word === API_ADDR_FLAG && typeof cmd[index + 1] === 'string') {
      addr = cmd[index + 1] as string;
      index++;
    }
  }
  const colon = addr.lastIndexOf(':');
  return colon < 0 ? addr : addr.slice(0, colon);
}

/**
 * True when the node's API at `apiPort` answers on every address of its host, false when it is bound to one, and null
 * when the inspect does not say: no binding names the port, or it is not an inspect at all.
 *
 * Bridged, the bindings Docker publishes on `apiPort` decide it, and the P2P port, which is on every address on
 * purpose, is not read. Under host networking nothing is published, and the process's own `--api-addr` is the bind.
 */
export function beeApiOnEveryAddress(inspect: unknown, apiPort: number): boolean | null {
  if (!inspect || typeof inspect !== 'object') return null;
  const { ports, networkMode, cmd } = inspect as Partial<BeeApiInspect>;
  if (networkMode === 'host') {
    const host = apiAddrHost(cmd);
    return host === null ? null : EVERY_ADDRESS.has(host);
  }
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) return null;
  const hostIps: string[] = [];
  for (const published of Object.values(ports as Record<string, unknown>)) {
    if (!Array.isArray(published)) continue;
    for (const binding of published) {
      const { HostIp, HostPort } = (binding ?? {}) as { HostIp?: unknown; HostPort?: unknown };
      if (String(HostPort) === String(apiPort) && typeof HostIp === 'string') hostIps.push(HostIp);
    }
  }
  if (hostIps.length === 0) return null;
  return hostIps.some((ip) => EVERY_ADDRESS.has(ip));
}
