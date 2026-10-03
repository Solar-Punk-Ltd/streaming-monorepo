import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig } from '../src/config.js';
import { INGEST_RTMP, INGEST_SRT, readIngestProtocol } from '../src/ingestProtocol.js';

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-ingest-protocol-'));
  roots.push(rootDir);
  return loadConfig({ env: { E2E_PUBLIC_HOST: '203.0.113.10', ...env }, rootDir });
}

/**
 * Which protocol the publisher sends a broadcast over when a suite does not name one.
 *
 * SRT is the default because every suite before RTMP ingest was written against it, so a run that sets nothing has
 * to keep publishing exactly what it always did.
 */
describe('the ingest protocol a run publishes over', () => {
  it('is SRT when the run names none', () => {
    assert.equal(config({}).ingestProtocol, INGEST_SRT);
  });

  it('is RTMP when the run asks for it, so any suite can run over RTMP', () => {
    assert.equal(config({ E2E_INGEST_PROTOCOL: 'rtmp' }).ingestProtocol, INGEST_RTMP);
  });

  it('refuses a protocol it does not know, rather than publishing over a default nobody chose', () => {
    assert.throws(() => readIngestProtocol('rtmps'), /E2E_INGEST_PROTOCOL "rtmps"; expected one of: srt, rtmp/);
    assert.throws(() => readIngestProtocol('RTMP'), /expected one of: srt, rtmp/);
  });

  /** OME's compose publishes an SRT port and no RTMP one, so an RTMP publisher there would dial nothing. */
  it('refuses RTMP against OME, which takes SRT only in this stack', () => {
    assert.throws(() => config({ E2E_ENGINE: 'ome', E2E_INGEST_PROTOCOL: 'rtmp' }), /OME .* SRT only/);
  });
});
