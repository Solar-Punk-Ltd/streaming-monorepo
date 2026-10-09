import type { PublishedPortBinding, PublishedPortsSnapshot } from './PublishedPortsProbe.js';
import { config } from '../../utils/config.js';
import type { KnownHostNetworkPorts } from './knownHostNetworkPorts.js';
import { type PortKey, portKeyOf } from './portReservations.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unreadable published port observation');
  return value as Record<string, unknown>;
}

function nullableLabel(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Unreadable container label');
  return value;
}

/** Accepts only the projection of inspect that contains ownership and published ports. */
export function publishedBindings(value: unknown): PublishedPortBinding[] {
  const container = record(value);
  if (typeof container.id !== 'string' || !container.id) throw new Error('Missing container identity');
  const project = nullableLabel(container.project);
  const service = nullableLabel(container.service);
  if (container.ports === null) return [];
  const bindings = new Map<string, PublishedPortBinding>();
  for (const [name, published] of Object.entries(record(container.ports))) {
    const match = /^\d+\/(tcp|udp|sctp)$/.exec(name);
    if (!match) throw new Error('Unreadable port transport');
    if (match[1] === 'sctp' || published === null) continue;
    if (!Array.isArray(published)) throw new Error('Unreadable published port bindings');
    for (const raw of published) {
      const hostPort = record(raw).HostPort;
      if (typeof hostPort !== 'string' || !/^\d+$/.test(hostPort)) throw new Error('Unreadable published port');
      const port = Number(hostPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid published port');
      const binding: PublishedPortBinding = {
        containerId: container.id,
        project,
        service,
        port,
        protocol: match[1] as 'tcp' | 'udp',
      };
      bindings.set(portKeyOf(binding), binding);
    }
  }
  return [...bindings.values()];
}

function declaredBindings(
  row: Record<string, unknown>,
  project: string,
  declared: readonly PortKey[],
): PublishedPortBinding[] {
  const containerId = row.id;
  if (typeof containerId !== 'string' || !containerId) throw new Error('Missing container identity');
  const service = nullableLabel(row.service);
  return declared.map(({ port, protocol }) => ({ containerId, project, service, port, protocol }));
}

/**
 * Every binding the running containers hold, and the projects whose bindings cannot be known.
 *
 * A host-network container has no port map, so it is unverified unless its
 * compose project is one the operator declared in KNOWN_HOST_NETWORK_PORTS,
 * whose declared ports then count as that container's bindings.
 */
export function collectPublishedPorts(
  rows: readonly unknown[],
  known: KnownHostNetworkPorts = config.knownHostNetworkPorts,
): Omit<PublishedPortsSnapshot, 'daemonId'> {
  const bindings: PublishedPortBinding[] = [];
  const unverifiedProjects = new Set<string>();
  for (const value of rows) {
    const row = record(value);
    if (row.networkMode === 'host') {
      const project = nullableLabel(row.project);
      const declared = project === null ? undefined : known.get(project);
      if (project !== null && declared) bindings.push(...declaredBindings(row, project, declared));
      else unverifiedProjects.add(project ?? `external:${row.id}`);
    }
    bindings.push(...publishedBindings(row));
  }
  return { bindings, unverifiedProjects: [...unverifiedProjects] };
}
