import type { PortKey } from './portReservations.js';

/** The ports each named compose project holds on host networking, by project. */
export type KnownHostNetworkPorts = ReadonlyMap<string, readonly PortKey[]>;

const PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PORT = /^(\d+)\/(tcp|udp)$/;

function refuse(problem: string, raw: string): never {
  throw new Error(
    `KNOWN_HOST_NETWORK_PORTS ${problem}. Write <project>=<port>/<tcp|udp>,... with projects separated by ';', got: ${raw}`,
  );
}

/**
 * The host-network containers the operator vouches for, read from
 * KNOWN_HOST_NETWORK_PORTS, and empty when it is unset.
 *
 * Docker reports no port map for a container on the host's network, so the
 * port scan cannot see what such a container holds and refuses every removal,
 * handover and firewall export while one runs. A host's edge reverse proxy runs
 * that way for good. Naming its compose project here with the ports it listens
 * on, as in `edge=80/tcp,443/tcp,443/udp`, makes those ports bindings of that
 * container instead of an unknown.
 *
 * The trust is per compose project: every host-network container in a named
 * project counts as holding only the declared ports, so a port such a
 * container holds and the entry leaves out counts as free. A deployment's
 * compose project is its name, which is why `knownHostNetworkNameProblem`
 * keeps deployments off the declared names.
 *
 * A malformed value stops the manager at startup rather than being dropped,
 * because a dropped entry is a host where nothing can be removed again, and a
 * wrong one is a port the manager believes free while a proxy holds it.
 */
export function knownHostNetworkPorts(raw: string | undefined): KnownHostNetworkPorts {
  const value = raw?.trim();
  const known = new Map<string, PortKey[]>();
  if (!value) return known;
  for (const entry of value.split(';').map((part) => part.trim())) {
    const parts = entry.split('=');
    if (parts.length !== 2) refuse('needs exactly one = in each entry', raw!);
    const project = parts[0]!.trim();
    if (!PROJECT.test(project)) refuse('names a compose project that is not one', raw!);
    if (known.has(project)) refuse(`names ${project} twice`, raw!);
    const ports: PortKey[] = [];
    for (const declared of parts[1]!.split(',').map((part) => part.trim())) {
      const match = PORT.exec(declared);
      const port = Number(match?.[1]);
      if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
        refuse(`has a port that is not <1-65535>/<tcp|udp>: '${declared}'`, raw!);
      }
      const protocol = match[2] as PortKey['protocol'];
      if (ports.some((seen) => seen.port === port && seen.protocol === protocol)) {
        refuse(`names ${declared} twice for ${project}`, raw!);
      }
      ports.push({ port, protocol });
    }
    known.set(project, ports);
  }
  return known;
}

function declaredText(project: string, ports: readonly PortKey[]): string {
  return `${project}=${ports.map(({ port, protocol }) => `${port}/${protocol}`).join(',')}`;
}

/**
 * Why a deployment may not be called this, or null when it may.
 *
 * The setting is matched on the compose project label alone, and a managed
 * deployment's compose project is its name. A deployment named after a
 * declared project would have its host-network containers count as holding
 * only the declared ports, so whatever else it listens on would never be
 * reserved and could be handed to another deployment.
 */
export function knownHostNetworkNameProblem(name: string, known: KnownHostNetworkPorts): string | null {
  const declared = known.get(name);
  if (!declared) return null;
  return (
    `name ${name} is a compose project KNOWN_HOST_NETWORK_PORTS declares (${declaredText(name, declared)}), ` +
    `and a deployment's compose project is its name, so its host-network ports would go unreserved. Choose another name`
  );
}

/**
 * Stops the manager when an existing deployment carries a declared project's
 * name, which happens when the setting names a project after the deployment
 * was created. Refusing to start is the side that fails closed: running would
 * leave that deployment's host-network ports unreserved until someone noticed.
 */
export function refuseDeploymentsNamedAsKnownHostNetworkProjects(
  deploymentNames: readonly string[],
  known: KnownHostNetworkPorts,
): void {
  const clashes = deploymentNames.filter((name) => known.has(name));
  if (clashes.length === 0) return;
  const declared = clashes.map((name) => declaredText(name, known.get(name)!)).join(';');
  throw new Error(
    `Deployment ${clashes.join(', ')} has the name of a compose project KNOWN_HOST_NETWORK_PORTS declares (${declared}). ` +
      `A deployment's compose project is its name, so its host-network ports would go unreserved. ` +
      `Take that project out of KNOWN_HOST_NETWORK_PORTS, start the manager, and remove the deployment before declaring the project again.`,
  );
}
