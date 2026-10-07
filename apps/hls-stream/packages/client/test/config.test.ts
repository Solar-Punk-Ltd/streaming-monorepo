import { afterEach, describe, expect, it, vi } from 'vitest';

const PROVIDERS = {
  gateways: [
    { id: 'event', kind: 'bee-http', url: '/bee' },
    { id: 'spare', kind: 'bee-http', url: 'https://spare.example.com' },
  ],
  default: 'event',
  fallback: 'spare',
};

/** The config module as a build with these variables reads it, since it reads them once at import. */
async function configWith(providers: string | undefined) {
  vi.stubEnv('VITE_SWARM_PROVIDERS', providers);
  vi.resetModules();
  return (await import('../src/utils/config')).config;
}

describe("the build's gateways", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('are the one Bee URL when the build names no providers', async () => {
    expect((await configWith(undefined)).providers).toBeNull();
  });

  it('are the providers setting when the build names one', async () => {
    expect((await configWith(JSON.stringify(PROVIDERS))).providers).toEqual(PROVIDERS);
  });

  it('refuse to start on a providers setting that is wrong, saying where', async () => {
    await expect(configWith(JSON.stringify({ ...PROVIDERS, default: 'elsewhere' }))).rejects.toThrow(
      /VITE_SWARM_PROVIDERS.*default/,
    );
  });
});
