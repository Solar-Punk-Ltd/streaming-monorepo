/**
 * What the Stages page says about each stage `GET /stages` answers: its kind and engine, its status, the readiness
 * verdict with its reasons, the owner shortened, the ingest host and ports, the token kind, the last push with how
 * long ago it was, and the reason a record could not be put together. Rows come by name, and a failed read says how
 * old the answer still shown is.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ConsoleStage,
  type ConsoleStageRecord,
  NO_VALUE,
  shortHex,
  STAGE_PUSH_OUTCOMES,
  stageRegistrationLine,
} from '@streaming-infra-manager/common';

import { ROTATE_ADMIN_TOKEN_LABEL } from '../deployments/stageText';
import {
  agoText,
  ingestView,
  kindLine,
  ownerView,
  pushView,
  readFailureLine,
  readinessView,
  STAGE_NO_RECORD,
  stageRows,
  stageRowView,
  STAGES_LEAD,
  STAGES_REFRESH_MS,
  statusView,
  tokenView,
} from './stagesView';

const OWNER = `0x${'ab'.repeat(20)}`;
const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse(AT);

function record(over: Partial<ConsoleStageRecord> = {}): ConsoleStageRecord {
  return {
    schemaVersion: 1,
    stageId: '00000000-0000-4000-8000-000000000001',
    managerId: '00000000-0000-4000-8000-00000000cafe',
    name: 'stage-one',
    kind: 'streamer',
    engine: 'srs',
    stackVersion: 'v3.4',
    status: 'RUNNING',
    observedAt: AT,
    ingest: { host: 'ingest.example.org', srtPort: 10012, rtmpPort: 10013, rtmpPublic: true, hasSrtPassphrase: true },
    owner: OWNER,
    rungs: [],
    uploader: null,
    readiness: { tone: 'ready', reasons: [] },
    adminToken: { kind: 'own' },
    ...over,
  };
}

function stage(over: Partial<ConsoleStage> = {}): ConsoleStage {
  return { name: 'stage-one', record: record(), problem: null, lastPush: { outcome: 'stored', at: AT }, ...over };
}

describe('what a stage is, under its name', () => {
  it('names its kind and engine, and its stack version when it has one', () => {
    assert.equal(kindLine(record()), 'Stream · SRS · stack v3.4');
    assert.equal(
      kindLine(record({ kind: 'abr-uploader', engine: 'ome', stackVersion: null })),
      'ABR uploader · OvenMediaEngine',
    );
  });
});

describe('the deployment status', () => {
  it('is said in the words and tone every row of the console gives it, pulsing while it changes', () => {
    assert.deepEqual(statusView('RUNNING'), { label: 'Running', tone: 'ok', pulsing: false });
    assert.deepEqual(statusView('STOPPED'), { label: 'Stopped', tone: 'gray', pulsing: false });
    assert.deepEqual(statusView('DEPLOYING'), { label: 'Deploying', tone: 'info', pulsing: true });
    assert.deepEqual(statusView('ERROR'), { label: 'Error', tone: 'err', pulsing: false });
  });

  it('passes a status it does not know through as it is', () => {
    assert.deepEqual(statusView('PAUSED'), { label: 'PAUSED', tone: 'gray', pulsing: false });
  });
});

describe('the readiness verdict', () => {
  it('is the web2 admin’s word on the console’s tone, blocked in red as it is there', () => {
    assert.deepEqual(readinessView({ tone: 'ready', reasons: [] }), { label: 'Ready', tone: 'ok', reasons: [] });
    assert.equal(readinessView({ tone: 'warning', reasons: [] }).tone, 'warn');
    assert.equal(readinessView({ tone: 'blocked', reasons: [] }).tone, 'err');
    assert.deepEqual(
      [readinessView({ tone: 'unknown', reasons: [] }).label, readinessView({ tone: 'unknown', reasons: [] }).tone],
      ['Unknown', 'info'],
    );
  });

  it('keeps every reason in the manager’s order, so the first is the console’s own label', () => {
    const reasons = ['Stamp ends soon', 'Chequebook low'];
    assert.deepEqual(readinessView({ tone: 'warning', reasons }).reasons, reasons);
  });
});

describe('the owner', () => {
  it('is shortened for the table and kept whole for the copy', () => {
    const view = ownerView(OWNER);
    assert.equal(view.address, OWNER);
    assert.equal(view.short, shortHex(OWNER));
    assert.ok(view.short.length < OWNER.length);
  });
});

describe('the ingest', () => {
  it('names the host, the SRT port with whether a passphrase goes with it, and the RTMP port as unencrypted', () => {
    assert.deepEqual(ingestView(record().ingest), {
      host: 'ingest.example.org',
      ports: 'SRT 10012, with a passphrase · RTMP 10013, unencrypted',
    });
    assert.equal(
      ingestView({ ...record().ingest, hasSrtPassphrase: false }).ports,
      'SRT 10012, no passphrase · RTMP 10013, unencrypted',
    );
  });

  it('says a stage that takes no RTMP, such as an OvenMediaEngine one, offers none', () => {
    assert.equal(
      ingestView({ ...record().ingest, rtmpPublic: false }).ports,
      'SRT 10012, with a passphrase · RTMP not offered',
    );
  });
});

describe('the token the uploader presents', () => {
  it('is its own, none, or a shared one the admin refuses, with what to do about it', () => {
    assert.deepEqual(tokenView({ kind: 'own' }), { label: 'Own', tone: 'ok', note: null });
    assert.deepEqual(tokenView(null), { label: 'None', tone: 'gray', note: null });
    const shared = tokenView({ kind: 'shared' });
    assert.deepEqual([shared.label, shared.tone], ['Shared', 'err']);
    assert.ok(shared.note?.includes(ROTATE_ADMIN_TOKEN_LABEL), shared.note ?? 'no note');
    assert.match(shared.note ?? '', /redeploy/);
  });
});

describe('how long ago', () => {
  const ago = (seconds: number) => agoText(AT, NOW + seconds * 1000);

  it('counts seconds for the first minute, as the stage card does', () => {
    assert.equal(ago(0), '0 s ago');
    assert.equal(ago(7), '7 s ago');
    assert.equal(ago(59), '59 s ago');
    assert.equal(stageRegistrationLine({ outcome: 'stored', at: AT }, NOW + 7_000).endsWith(ago(7)), true);
  });

  it('then minutes, hours and days, in whole units', () => {
    assert.equal(ago(60), '1 min ago');
    assert.equal(ago(3_599), '59 min ago');
    assert.equal(ago(3_600), '1 h ago');
    assert.equal(ago(86_399), '23 h ago');
    assert.equal(ago(86_400), '1 d ago');
    assert.equal(ago(10 * 86_400 + 5), '10 d ago');
  });

  it('reads a moment ahead of the clock as now, and one that is no moment as the dash', () => {
    assert.equal(ago(-30), '0 s ago');
    assert.equal(agoText('not a moment', NOW), NO_VALUE);
  });
});

describe('the last push', () => {
  it('says not pushed yet before any', () => {
    assert.deepEqual(pushView(null, NOW), { label: 'Not pushed yet', tone: 'gray', ago: null, at: null });
  });

  it('names the outcome in the stage card’s words, with how long ago and when', () => {
    const view = pushView({ outcome: 'stored', at: AT }, NOW + 12_000);
    assert.deepEqual([view.label, view.tone, view.ago], ['Registered', 'ok', '12 s ago']);
    assert.notEqual(view.at, null);
    assert.notEqual(view.at, 'time unknown');
  });

  it('is an error where the admin refused it or none answered, and off where the operator left it unpushed', () => {
    for (const outcome of [
      'refused-token',
      'refused-record',
      'refused-plain-http',
      'unreachable',
      'redirected',
      'not-admin',
    ] as const) {
      assert.equal(pushView({ outcome, at: AT }, NOW).tone, 'err', outcome);
    }
    for (const outcome of ['skipped-not-linked', 'skipped-other-origin'] as const) {
      assert.equal(pushView({ outcome, at: AT }, NOW).tone, 'gray', outcome);
    }
    for (const outcome of ['skipped-no-link', 'skipped-no-record'] as const) {
      assert.equal(pushView({ outcome, at: AT }, NOW).tone, 'warn', outcome);
    }
  });

  it('has a capitalised label and a tone for every outcome the manager answers', () => {
    for (const outcome of STAGE_PUSH_OUTCOMES) {
      const view = pushView({ outcome, at: AT }, NOW);
      assert.match(view.label, /^[A-Z]/, outcome);
      assert.ok(['ok', 'warn', 'err', 'info', 'gray'].includes(view.tone), outcome);
    }
  });
});

describe('a stage’s row', () => {
  it('fills every column from the record', () => {
    const row = stageRowView(stage(), NOW + 3_000);
    assert.equal(row.name, 'stage-one');
    assert.equal(row.problem, null);
    assert.deepEqual(row.record, {
      kind: 'Stream · SRS · stack v3.4',
      status: { label: 'Running', tone: 'ok', pulsing: false },
      readiness: { label: 'Ready', tone: 'ok', reasons: [] },
      owner: { address: OWNER, short: shortHex(OWNER) },
      ingest: { host: 'ingest.example.org', ports: 'SRT 10012, with a passphrase · RTMP 10013, unencrypted' },
      token: { label: 'Own', tone: 'ok', note: null },
    });
    assert.equal(row.lastPush.ago, '3 s ago');
  });

  it('says why the record could not be put together in place of its columns', () => {
    const problem = "set the deployment's public ingest address or PUBLIC_HOST";
    const row = stageRowView(stage({ record: null, problem, lastPush: { outcome: 'skipped-no-record', at: AT } }), NOW);
    assert.equal(row.record, null);
    assert.equal(row.problem, problem);
    assert.equal(row.lastPush.label, 'Not pushed (the record is incomplete)');
  });

  it('still says something for a record that came back with no reason', () => {
    assert.equal(stageRowView(stage({ record: null, problem: null }), NOW).problem, STAGE_NO_RECORD);
  });
});

describe('the rows', () => {
  it('come by name, whatever order the manager answered in, and leave the answer as it was', () => {
    const answer = [stage({ name: 'stage-c' }), stage({ name: 'stage-a' }), stage({ name: 'stage-b' })];
    assert.deepEqual(
      stageRows(answer, NOW).map((row) => row.name),
      ['stage-a', 'stage-b', 'stage-c'],
    );
    assert.deepEqual(
      answer.map((entry) => entry.name),
      ['stage-c', 'stage-a', 'stage-b'],
    );
  });

  it('are none for a manager that runs no stage', () => {
    assert.deepEqual(stageRows([], NOW), []);
  });
});

describe('what the page says', () => {
  it('reads the stages again on the cadence the manager pushes a running stage on, and says so', () => {
    assert.equal(STAGES_REFRESH_MS, 30_000);
    assert.match(STAGES_LEAD, /every 30 seconds/);
  });

  it('says why a read failed, and how old the answer still shown is', () => {
    assert.equal(
      readFailureLine('request failed (502)', null, NOW),
      'Could not read the stages from the manager. request failed (502)',
    );
    assert.equal(
      readFailureLine('request failed (502)', AT, NOW + 95_000),
      'Could not read the stages again, so the table is the answer read 1 min ago. request failed (502)',
    );
  });
});
