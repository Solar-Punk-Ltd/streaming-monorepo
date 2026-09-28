/**
 * What the deployment page's stage card says: which deployments have one, the
 * public ingest address and where it comes from, what the field takes, and the
 * registration line.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INGEST_HOST_HELP, stageRegistrationLine } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { ingestHostDraftProblem, ingestHostToSave, ingestHostView, isStage } from './stageText';

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    name: 'stage-one',
    kind: 'streamer',
    status: 'RUNNING',
    network_host: '192.0.2.10',
    ingest_host: null,
    containers: [],
    ...over,
  }) as Profile;

describe('which deployments are stages', () => {
  it('is an ABR uploader and a streamer', () => {
    assert.equal(isStage(profile()), true);
    assert.equal(isStage(profile({ kind: 'abr-uploader' })), true);
    assert.equal(isStage(profile({ kind: 'viewer' })), false);
    assert.equal(isStage(profile({ kind: 'custom' })), false);
  });
});

describe('the public ingest address on the card', () => {
  it('is the deployment’s own when it has one', () => {
    const view = ingestHostView(profile({ ingest_host: 'ingest.example.org' }), 'manager.example.org');
    assert.deepEqual([view.address, view.own], ['ingest.example.org', true]);
    assert.match(view.source, /set for this deployment/i);
  });

  it('is the resolved host otherwise, and the manager’s own address for a local deployment', () => {
    assert.equal(ingestHostView(profile(), 'manager.example.org').address, '192.0.2.10');
    const local = ingestHostView(profile({ network_host: 'localhost' }), 'manager.example.org');
    assert.deepEqual([local.address, local.own], ['manager.example.org', false]);
    assert.match(local.source, /resolved/);
  });

  it('says a loopback address is not pushed', () => {
    const view = ingestHostView(profile({ network_host: 'localhost' }), 'localhost');
    assert.match(view.source, /does not push the stage/);
  });

  it('says what the field is for in the one sentence the brief gives it', () => {
    assert.equal(INGEST_HOST_HELP, 'The address encoders dial. The address ssh uses can be a private one.');
  });
});

describe('what the field takes', () => {
  it('takes a host name, an address, or nothing, which goes back to the resolved host', () => {
    for (const draft of ['ingest.example.org', '192.0.2.10', '[2001:db8::1]', '', '   ']) {
      assert.equal(ingestHostDraftProblem(draft), null, draft);
    }
    assert.equal(ingestHostToSave('  ingest.example.org '), 'ingest.example.org');
    assert.equal(ingestHostToSave('  '), null);
  });

  it('refuses a scheme, a port and a path', () => {
    for (const draft of [
      'srt://ingest.example.org',
      'ingest.example.org:9000',
      'ingest.example.org/live',
      'localhost',
    ]) {
      assert.notEqual(ingestHostDraftProblem(draft), null, draft);
    }
  });
});

describe('the registration line', () => {
  it('names the last push’s outcome and how many seconds ago', () => {
    const at = '2026-09-28T10:00:00.000Z';
    assert.equal(
      stageRegistrationLine({ outcome: 'stored', at }, Date.parse(at) + 7_000),
      'Web2 admin registration: registered 7 s ago',
    );
    assert.equal(
      stageRegistrationLine({ outcome: 'skipped-other-origin', at }, Date.parse(at) + 30_000),
      'Web2 admin registration: not pushed (linked to another admin than the manager’s) 30 s ago',
    );
  });
});
