/**
 * Where the deployment host answers a port the stack binds to its Docker bridge address wherever the
 * port's own bind setting is empty: the Bee APIs, SRS's HTTP server and API, and OME's HLS port.
 * Nothing listens on 127.0.0.1 for those on a default Linux host.
 *
 * Mirrors `deploy/scripts/bound-host.sh`, and `test/boundHost.test.ts` runs the shell functions over
 * the same inputs and compares.
 */

import type { EnvBag } from './envFile.js';

/** What compose binds a port to when the deploy named no bridge address. */
export const LOOPBACK_ADDRESS = '127.0.0.1';

/** A port the stack binds to the bridge address unless `bind` names another. */
export interface BoundPort {
  readonly port: number;
  /** The port's bind setting as the env files have it, empty when they set none. */
  readonly bind: string;
}

/**
 * The address a port answers on, from its bind setting the way compose reads it: the address it
 * names, 127.0.0.1 for every address, and `bridge` when it names none.
 */
export function boundHost(bind: string, bridge: string): string {
  if (bind === '') {
    return bridge;
  }
  if (bind === '0.0.0.0' || bind === '::' || bind === '[::]') {
    return LOOPBACK_ADDRESS;
  }
  return bind;
}

/**
 * The name of a Bee node's bind setting by its prefix: `*_API_BIND` on a bridge network, and under
 * host networking `*_API_LISTEN`, the process's own address, which is the whole bind there.
 */
export function beeApiBindKey(prefix: string, env: EnvBag): string {
  return env.COMPOSE_NETWORK === 'host' ? `${prefix}_API_LISTEN` : `${prefix}_API_BIND`;
}

/** A Bee node's bind setting by its prefix, empty when the env sets none. */
export function beeApiBind(prefix: string, env: EnvBag): string {
  return env[beeApiBindKey(prefix, env)] ?? '';
}
