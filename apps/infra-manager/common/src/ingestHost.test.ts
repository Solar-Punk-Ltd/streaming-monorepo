/**
 * The public ingest address: what the field takes, and what a deployment's
 * address comes to without one.
 *
 * Unit test, no network. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stageIngestSchema } from '@streaming-monorepo/contracts';

import { ingestHostProblem, isLoopbackIngestHost, isStageKind, resolvedIngestHost } from './ingestHost.js';

describe('the ingest address field', () => {
  it('takes a host name, an IPv4 address and a bracketed IPv6 one', () => {
    for (const host of ['ingest.example.org', 'Ingest.Example.org', '192.0.2.10', '[2001:db8::1]', 'stage-1']) {
      assert.equal(ingestHostProblem(host), null, host);
    }
  });

  it('refuses a scheme, a port, a path, a credential, a bare IPv6 address and spaces', () => {
    for (const host of [
      'srt://ingest.example.org',
      'ingest.example.org:9000',
      'ingest.example.org/live',
      'user@ingest.example.org',
      '2001:db8::1',
      ' ingest.example.org',
      'ingest example.org',
      '',
      'a'.repeat(254),
    ]) {
      assert.notEqual(ingestHostProblem(host), null, host);
    }
  });

  it('refuses an address that reaches this host alone', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'stage.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '[::1]',
      '[::]',
    ]) {
      assert.match(ingestHostProblem(host) ?? '', /reaches this host alone/, host);
    }
  });

  it('takes what the stage record takes, loopback aside, so a saved address is one the record carries', () => {
    for (const host of ['ingest.example.org', '192.0.2.10', '[2001:db8::1]', 'ingest.example.org:9000', 'x/y']) {
      assert.equal(ingestHostProblem(host) === null, stageIngestSchema.shape.host.safeParse(host).success, host);
    }
  });

  it('never repeats the value it refuses', () => {
    const value = 'secret-looking.example.org:1234';
    assert.doesNotMatch(ingestHostProblem(value) ?? '', /secret-looking/);
  });
});

describe('the address a deployment’s encoders dial', () => {
  it('is the deployment’s own setting when it has one', () => {
    assert.equal(
      resolvedIngestHost({ ingest_host: 'ingest.example.org', network_host: '10.0.0.5' }, 'manager.example.org'),
      'ingest.example.org',
    );
  });

  it('is the host the manager resolved for a deployment on another host', () => {
    assert.equal(
      resolvedIngestHost({ ingest_host: null, network_host: '192.0.2.20' }, 'manager.example.org'),
      '192.0.2.20',
    );
  });

  it('is the manager’s public address for a deployment on the manager’s own host', () => {
    for (const local of ['', 'localhost', '127.0.0.1', 'native', null]) {
      assert.equal(
        resolvedIngestHost({ ingest_host: '  ', network_host: local }, 'manager.example.org'),
        'manager.example.org',
      );
    }
  });
});

describe('which deployments are stages', () => {
  it('is an ABR uploader and a streamer, and nothing else', () => {
    assert.equal(isStageKind('abr-uploader'), true);
    assert.equal(isStageKind('streamer'), true);
    assert.equal(isStageKind('viewer'), false);
    assert.equal(isStageKind('custom'), false);
  });
});

describe('a loopback address', () => {
  it('is one that reaches the dialling machine alone, or none', () => {
    for (const host of [
      'localhost',
      'a.localhost',
      '127.0.0.1',
      '127.255.0.9',
      '0.0.0.0',
      '[::1]',
      '[::]',
      '',
      '[::ffff:127.0.0.1]',
    ]) {
      assert.equal(isLoopbackIngestHost(host), true, host);
    }
  });

  it('is not a public name or address', () => {
    for (const host of ['ingest.example.org', '192.0.2.10', '[2001:db8::1]', 'localhost.example.org', '198.51.100.7']) {
      assert.equal(isLoopbackIngestHost(host), false, host);
    }
  });
});
