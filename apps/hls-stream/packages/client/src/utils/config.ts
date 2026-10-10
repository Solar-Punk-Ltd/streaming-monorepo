import { playerRelease } from './playerRelease';
import { parseProvidersSetting, type ProvidersSetting } from '@/swarm/settings';

function getEnv(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** The gateways a build offers, or null when it names only `VITE_READER_BEE_URL`. */
function readProviders(): ProvidersSetting | null {
  const raw: unknown = import.meta.env.VITE_SWARM_PROVIDERS;
  return typeof raw === 'string' && raw.trim() !== '' ? parseProvidersSetting(raw) : null;
}

const rawBeeUrl = getEnv('VITE_READER_BEE_URL');
const useProxy = import.meta.env.DEV && isLocalUrl(rawBeeUrl);

export const config = {
  beeUrl: useProxy ? '/bee' : rawBeeUrl,
  /** When set, the gateways every read goes to, and `beeUrl` is left to the dev server's proxy. */
  providers: readProviders(),
  appOwner: getEnv('VITE_APP_OWNER'),
  rawAppTopic: getEnv('VITE_APP_RAW_TOPIC'),
  /**
   * The release the bundle was built as, which the QoE overlay shows, or null when its deploy named
   * none. Optional, unlike the three above: a build with no release is an ordinary one.
   */
  release: playerRelease(import.meta.env.VITE_APP_RELEASE_LABEL, import.meta.env.VITE_APP_RELEASE_COMMIT),
};
