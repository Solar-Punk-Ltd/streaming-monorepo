import type { SwarmProvider } from './provider';
import type { ProviderKindName } from './providerKinds';
import { BeeHttpProvider } from './providers/bee-http/beeHttpProvider';
import type { GatewaySetting } from './settings';

/** What every provider is made with, apart from its own settings. */
export interface ProviderEnvironment {
  /** Injected by tests. The global `fetch` otherwise. */
  readonly fetcher?: typeof fetch;
  /** The page's own origin. Read from the page when absent. */
  readonly pageOrigin?: string;
}

/** One kind of provider: what a viewer is shown it as, and how one is made from a gateway's settings. */
export interface ProviderKind {
  readonly label: string;
  create(gateway: GatewaySetting, environment: ProviderEnvironment): SwarmProvider;
}

/** Every kind this build carries. A kind added here is offered wherever a setting lists it. */
export const PROVIDER_REGISTRY: Readonly<Record<ProviderKindName, ProviderKind>> = {
  'bee-http': {
    label: 'A Bee node over HTTP',
    create: (gateway, environment) => new BeeHttpProvider({ baseUrl: gateway.url, ...environment }),
  },
};
