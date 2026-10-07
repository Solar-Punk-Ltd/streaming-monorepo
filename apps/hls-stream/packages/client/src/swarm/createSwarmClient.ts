import { SwarmClient, type NamedProvider, type SwarmClientOptions, type SwarmFeature } from './client';
import { PROVIDER_REGISTRY, type ProviderEnvironment, type ProviderKind } from './registry';
import type { GatewaySetting, SwarmSettings } from './settings';
import type { ProviderKindName } from './providerKinds';

interface CreateSwarmClientOptions {
  /**
   * The viewer's choice: the id of a gateway the settings offer, or a gateway of the viewer's own such
   * as a node on their machine. Absent, or an id no longer offered, means the default.
   */
  readonly choice?: string | GatewaySetting;
  /**
   * A gateway of its own for a feature, with the deployment's fallback behind it. Every other feature
   * reads from the viewer's choice.
   */
  readonly routes?: Partial<Record<SwarmFeature, GatewaySetting>>;
  readonly environment?: ProviderEnvironment;
  /** Injected by tests. {@link PROVIDER_REGISTRY} otherwise. */
  readonly registry?: Readonly<Record<ProviderKindName, ProviderKind>>;
  /** Everything else the client takes, such as a feature's own route or the clock. */
  readonly client?: Omit<SwarmClientOptions, 'chosen' | 'fallback' | 'routes'>;
}

/** The Swarm client the settings and the viewer's choice describe, its providers made by their kinds. */
export function createSwarmClient(settings: SwarmSettings, options: CreateSwarmClientOptions = {}): SwarmClient {
  const { choice, routes = {}, environment = {}, registry = PROVIDER_REGISTRY } = options;
  const offered = (id: string | null) => settings.gateways.find((gateway) => gateway.id === id) ?? null;
  const make = (gateway: GatewaySetting): NamedProvider => ({
    id: gateway.id,
    provider: registry[gateway.kind].create(gateway, environment),
  });

  const chosen =
    (typeof choice === 'string' ? offered(choice) : choice) ?? offered(settings.defaultId) ?? settings.gateways[0];
  // A viewer on the fallback gateway itself has the default behind them, so the build's own gateway is
  // behind every other choice for as long as the build keeps the fallback on.
  const fallback =
    settings.fallbackId === null
      ? null
      : ([offered(settings.fallbackId), offered(settings.defaultId)].find(
          (gateway) => gateway !== null && gateway.id !== chosen.id,
        ) ?? null);

  return new SwarmClient({
    ...options.client,
    chosen: make(chosen),
    fallback: fallback ? make(fallback) : null,
    routes: Object.fromEntries(Object.entries(routes).map(([feature, gateway]) => [feature, make(gateway)])) as Partial<
      Record<SwarmFeature, NamedProvider>
    >,
  });
}
