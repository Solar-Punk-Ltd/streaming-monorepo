import { PROVIDER_KINDS, type ProviderKindName } from './providerKinds';

/** One gateway the deployment offers, which a provider kind in the registry makes a provider from. */
export interface GatewaySetting {
  /** What the default, the fallback and the counts name it by. */
  readonly id: string;
  readonly kind: ProviderKindName;
  /** What a viewer is shown it as. */
  readonly label?: string;
  /** A Bee API base: a path on this site such as `/bee`, or an http or https address. */
  readonly url: string;
}

/** The gateways a build names in `VITE_SWARM_PROVIDERS`, as JSON. */
export interface ProvidersSetting {
  readonly gateways: readonly GatewaySetting[];
  /** The id of the gateway every reader starts on. */
  readonly default: string;
  /** The id of the gateway asked when the one in use fails. Absent means none. */
  readonly fallback?: string;
  /** The kinds of provider a viewer may add one of their own of. Absent means every kind this build carries. */
  readonly kinds?: readonly ProviderKindName[];
}

/** What the Swarm client is made from, whichever way the build named its gateways. */
export interface SwarmSettings {
  readonly gateways: readonly GatewaySetting[];
  readonly defaultId: string;
  /** The gateway asked when the one in use fails, or null for none. */
  readonly fallbackId: string | null;
  /** The kinds of provider a viewer may add one of their own of. */
  readonly kinds: readonly ProviderKindName[];
}

/** The id the one gateway of a build that names only its Bee URL goes by. */
export const SINGLE_GATEWAY_ID = 'gateway';

/** The id a Bee node of the viewer's own goes by, one the settings do not offer. */
export const OWN_GATEWAY_ID = 'own-node';

/** An example's `<...>` value, which a build that forgot to fill one in must not start on. */
const PLACEHOLDER = /^<.*>$/s;

const isRootedPathOrHttpUrl = (value: string) =>
  (value.startsWith('/') && !value.startsWith('//')) || /^https?:\/\/[^/]/i.test(value);

const isProviderKind = (value: unknown): value is ProviderKindName =>
  typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);

/** Collects every problem a setting has, each named by where it is, as `gateways.0.url`. */
class Problems {
  readonly found: string[] = [];

  add(path: string, message: string): void {
    this.found.push(`${path}: ${message}`);
  }

  /** The value when it is a filled-in, non-empty string, and null after recording why not. */
  text(value: unknown, path: string): string | null {
    if (typeof value !== 'string' || value.trim() === '') {
      this.add(path, 'must be a string that is not empty');
      return null;
    }
    if (PLACEHOLDER.test(value.trim())) {
      this.add(path, 'still holds the example placeholder');
      return null;
    }
    return value;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function gatewayOf(raw: unknown, path: string, problems: Problems): GatewaySetting | null {
  if (!isRecord(raw)) {
    problems.add(path, 'must be an object');
    return null;
  }
  const id = problems.text(raw.id, `${path}.id`);
  if (!isProviderKind(raw.kind)) {
    problems.add(`${path}.kind`, `must be one of ${PROVIDER_KINDS.join(', ')}`);
  }
  const label = raw.label === undefined ? undefined : problems.text(raw.label, `${path}.label`);
  let url = problems.text(raw.url, `${path}.url`);
  if (url !== null && !isRootedPathOrHttpUrl(url)) {
    problems.add(`${path}.url`, 'must be a path on this site, such as /bee, or an http or https address');
    url = null;
  }
  if (id === null || !isProviderKind(raw.kind) || label === null || url === null) {
    return null;
  }
  return label === undefined ? { id, kind: raw.kind, url } : { id, kind: raw.kind, label, url };
}

/**
 * The providers setting a build was given, checked as a whole.
 *
 * @throws With every problem the setting has, so a build that got it wrong fails at start and says
 *   where, as a missing `VITE_` variable already does.
 */
export function parseProvidersSetting(raw: string): ProvidersSetting {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('VITE_SWARM_PROVIDERS is not JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('VITE_SWARM_PROVIDERS must be an object');
  }

  const problems = new Problems();
  const gateways: GatewaySetting[] = [];
  if (!Array.isArray(parsed.gateways) || parsed.gateways.length === 0) {
    problems.add('gateways', 'must offer at least one gateway');
  } else {
    const ids = new Set<string>();
    parsed.gateways.forEach((entry: unknown, at: number) => {
      const gateway = gatewayOf(entry, `gateways.${at}`, problems);
      if (gateway === null) {
        return;
      }
      if (ids.has(gateway.id)) {
        problems.add(`gateways.${at}.id`, 'is used by another gateway');
      }
      ids.add(gateway.id);
      gateways.push(gateway);
    });
  }

  const offered = new Set(gateways.map(({ id }) => id));
  const defaultId = problems.text(parsed.default, 'default');
  if (defaultId !== null && !offered.has(defaultId)) {
    problems.add('default', 'must name one of the gateways');
  }
  const fallback = parsed.fallback === undefined ? undefined : problems.text(parsed.fallback, 'fallback');
  if (typeof fallback === 'string' && !offered.has(fallback)) {
    problems.add('fallback', 'must name one of the gateways');
  } else if (typeof fallback === 'string' && fallback === defaultId) {
    problems.add('fallback', 'must name a gateway other than the default');
  }
  let kinds: ProviderKindName[] | undefined;
  if (parsed.kinds !== undefined) {
    if (!Array.isArray(parsed.kinds) || parsed.kinds.length === 0 || !parsed.kinds.every(isProviderKind)) {
      problems.add('kinds', `must list at least one of ${PROVIDER_KINDS.join(', ')} and nothing else`);
    } else {
      kinds = parsed.kinds;
    }
  }

  if (problems.found.length > 0 || defaultId === null || fallback === null) {
    throw new Error(`VITE_SWARM_PROVIDERS is wrong. ${problems.found.join('. ')}`);
  }
  return {
    gateways,
    default: defaultId,
    ...(fallback === undefined ? {} : { fallback }),
    ...(kinds === undefined ? {} : { kinds }),
  };
}

/** The two ways a build names its gateways, as `src/utils/config.ts` reads them. */
export interface GatewayConfig {
  /** The one Bee gateway of `VITE_READER_BEE_URL`, read only when no providers setting is given. */
  readonly beeUrl: string;
  readonly providers: ProvidersSetting | null;
}

/**
 * The settings a build describes. A build given no providers setting names one gateway,
 * `VITE_READER_BEE_URL`, and that is read as the only gateway offered and the default, with no
 * fallback, so a deployment built before providers existed needs no change to its settings.
 */
export function swarmSettingsFrom({ beeUrl, providers }: GatewayConfig): SwarmSettings {
  if (!providers) {
    return {
      gateways: [{ id: SINGLE_GATEWAY_ID, kind: 'bee-http', url: beeUrl }],
      defaultId: SINGLE_GATEWAY_ID,
      fallbackId: null,
      kinds: [...PROVIDER_KINDS],
    };
  }
  return {
    gateways: providers.gateways,
    defaultId: providers.default,
    fallbackId: providers.fallback ?? null,
    kinds: providers.kinds ?? [...PROVIDER_KINDS],
  };
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/** The gateway every reader starts on. The setting's own check makes sure the default names one. */
export function defaultGateway(settings: SwarmSettings): GatewaySetting {
  return settings.gateways.find((gateway) => gateway.id === settings.defaultId) ?? settings.gateways[0];
}

/**
 * The gateway a saved or picked address means. A viewer's choice is kept as an address, which is what
 * the node picker shows and what a choice saved before providers existed holds, so an address an
 * offered gateway has is that gateway, and any other is a Bee node of the viewer's own.
 */
export function choiceForAddress(settings: SwarmSettings, address: string): GatewaySetting {
  const wanted = withoutTrailingSlash(address);
  return (
    settings.gateways.find((gateway) => withoutTrailingSlash(gateway.url) === wanted) ?? {
      id: OWN_GATEWAY_ID,
      kind: 'bee-http',
      url: wanted,
    }
  );
}
