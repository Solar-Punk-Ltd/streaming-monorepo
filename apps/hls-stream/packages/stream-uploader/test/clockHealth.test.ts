import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  CLOCK_TRUSTED,
  CLOCK_UNCHECKED,
  CLOCK_UNTRUSTED,
  ClockCheckReport,
  HEALTH_DEGRADED,
  HEALTH_REASON_CLOCK_UNCHECKED,
  HEALTH_REASON_CLOCK_UNTRUSTED,
} from '../src/types.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const servers: ApiTestServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const UNTRUSTED: ClockCheckReport = {
  verdict: CLOCK_UNTRUSTED,
  checkedAt: '2026-10-06T12:00:00.000Z',
  server: 'time.example.com',
  offsetMs: 300,
  delayMs: 6,
  errorBoundMs: 303,
  maxErrorMs: 250,
};

async function api(clockReport?: () => ClockCheckReport): Promise<ApiTestServer> {
  const server = await startTestApi(makeTestOrchestrator(), [], undefined, undefined, clockReport);
  servers.push(server);
  return server;
}

describe('the clock check on /health', () => {
  it('answers 503 with clock_untrusted and the last offset, delay, server and check time', async () => {
    const server = await api(() => UNTRUSTED);
    const { status, body } = await server.request('/health');

    assert.equal(status, 503);
    const health = body as { status: string; reasons: string[]; clock: ClockCheckReport };
    assert.equal(health.status, HEALTH_DEGRADED);
    assert.deepEqual(health.reasons, [HEALTH_REASON_CLOCK_UNTRUSTED]);
    assert.deepEqual(health.clock, UNTRUSTED);
  });

  it('answers 503 with clock_unchecked when no time server answered', async () => {
    const unchecked: ClockCheckReport = {
      ...UNTRUSTED,
      verdict: CLOCK_UNCHECKED,
      server: null,
      offsetMs: null,
      delayMs: null,
      errorBoundMs: null,
    };
    const server = await api(() => unchecked);
    const { status, body } = await server.request('/health');

    assert.equal(status, 503);
    assert.deepEqual((body as { reasons: string[] }).reasons, [HEALTH_REASON_CLOCK_UNCHECKED]);
    assert.equal((body as { clock: ClockCheckReport }).clock.verdict, CLOCK_UNCHECKED);
  });

  it('reads the report on every request, so a fixed clock leaves /health without a restart', async () => {
    let report = UNTRUSTED;
    const server = await api(() => report);
    assert.equal((await server.request('/health')).status, 503);

    report = { ...UNTRUSTED, verdict: CLOCK_TRUSTED, offsetMs: 2, errorBoundMs: 5 };
    const { status, body } = await server.request('/health');
    assert.equal(status, 200);
    assert.deepEqual((body as { reasons: string[] }).reasons, []);
  });

  it('carries the clock check onto /metrics as well', async () => {
    const server = await api(() => UNTRUSTED);
    const { body } = await server.request('/metrics');
    assert.match(String(body), /^swarm_hls_clock_untrusted 1$/m);
    assert.match(String(body), /^swarm_hls_clock_offset_seconds 0\.3$/m);
  });
});
