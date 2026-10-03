/**
 * The stage publisher: when it pushes a deployment's stage record, to whom, and
 * what it keeps and says of each push.
 *
 * Unit test on a fake clock and a fake admin client, no database, no network.
 * `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { StagePushOutcome } from '@streaming-infra-manager/common';
import type { StageRecord } from '@streaming-monorepo/contracts';

import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import type { BuiltStage } from '../../src/domain/stages/StageRecordBuilder.js';
import {
  STAGE_PUSH_BEFORE_START_MS,
  STAGE_PUSH_DEBOUNCE_MS,
  STAGE_PUSH_INTERVAL_MS,
  StagePublisher,
  consoleRecordOf,
  type StageClock,
} from '../../src/domain/stages/StagePublisher.js';
import type {
  DecidedRetirement,
  PendingRetirement,
  StageRetirementStore,
} from '../../src/domain/stages/StageRetirementRepository.js';
import type { StageRequest } from '../../src/domain/stages/stageRequest.js';
import type { ProfileKind, ProfileWithContainers } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';

const LINK_URL = 'https://admin.example.org';
const LINK_TOKEN = 'synthetic-registrar-token-0123456789abcdef';
const PASSPHRASE = 'synthetic-passphrase-0123';
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Timers that run only when the test moves time. */
class FakeClock implements StageClock {
  time = Date.parse('2026-09-28T10:00:00.000Z');
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown) => void this.timers.delete(handle as number);
  clearInterval = (handle: unknown) => void this.timers.delete(handle as number);

  private add(fn: () => void, ms: number, every?: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn, every });
    return id;
  }

  /** Moves time on, running each timer that falls due, and lets the promises it started settle. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

/** The event the orchestrator publishes once a deployment's row is deleted, at the clock's moment or a fixed one. */
function removal(
  name: string,
  n: number,
  clock?: FakeClock,
  kind: ProfileKind = 'streamer',
): Extract<ManagerEvent, { type: 'profile.deleted' }> {
  const at = clock?.time ?? Date.parse('2026-09-28T10:00:00.000Z');
  return { type: 'profile.deleted', name, instanceId: idOf(n), kind, deletedAt: new Date(at).toISOString() };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function stage(name: string, n: number, over: Partial<ProfileWithContainers> = {}): ProfileWithContainers {
  return {
    ...makeProfile({ name, kind: 'streamer', instance_id: idOf(n) }),
    containers: [],
    pendingStamp: false,
    network_host: '192.0.2.10',
    ...over,
  };
}

function recordOf(profile: ProfileWithContainers, readAt = new Date(0)): StageRecord {
  return {
    schemaVersion: 1,
    stageId: profile.instance_id,
    managerId: idOf(99),
    name: profile.name,
    kind: profile.kind as StageRecord['kind'],
    engine: 'srs',
    stackVersion: 'v3.4.0',
    status: profile.status,
    observedAt: readAt.toISOString(),
    ingest: {
      host: 'ingest.example.org',
      srtPort: 10012,
      rtmpPort: 10013,
      rtmpPublic: false,
      srtPassphrase: PASSPHRASE,
    },
    owner: `0x${'ab'.repeat(20)}`,
    rungs: [],
    uploader: null,
    readiness: { tone: 'ready', reasons: [] },
    adminToken: null,
  };
}

/** The pending retirements as the database keeps them, which outlive a publisher as they outlive a restart. */
class FakeRetirements implements StageRetirementStore {
  readonly rows = new Map<string, PendingRetirement>();

  pending = async () => [...this.rows.values()].map((row) => ({ ...row }));
  keep = async (retirement: DecidedRetirement) => {
    const kept = this.rows.get(retirement.stageId);
    if (kept?.deletedAt) return { ...kept, deletedAt: kept.deletedAt };
    this.rows.set(retirement.stageId, { ...retirement });
    return { ...retirement };
  };
  remove = async (stageId: string) => void this.rows.delete(stageId);
}

interface Setup {
  profiles?: ProfileWithContainers[];
  retirements?: FakeRetirements;
  link?: { url: string | null; token: string | null };
  /** The address each deployment's uploader is given, by name, the link's own when left out. */
  adminUrls?: Record<string, string>;
  problems?: Record<string, string>;
  answer?: (request: StageRequest) => Promise<StagePushOutcome> | StagePushOutcome;
  /** Runs while a record is being put together, after the row was read: where a slow reading waits. */
  duringBuild?: () => Promise<void>;
}

function publisherFor(setup: Setup = {}) {
  const clock = new FakeClock();
  const events = new EventBus();
  const profiles = new Map((setup.profiles ?? [stage('stage-one', 1)]).map((profile) => [profile.name, profile]));
  // A copy the test may change, as a save of the Manager settings page would.
  const link = { ...(setup.link ?? { url: LINK_URL, token: LINK_TOKEN }) };
  const sent: StageRequest[] = [];
  const builds: string[] = [];
  const retirements = setup.retirements ?? new FakeRetirements();
  const publisher = new StagePublisher({
    profiles: {
      list: async () => [...profiles.values()],
      find: async (name) => profiles.get(name) ?? null,
    },
    builder: {
      async build(profile, readAt = new Date()): Promise<BuiltStage> {
        builds.push(profile.name);
        await setup.duringBuild?.();
        const problem = setup.problems?.[profile.name];
        if (problem) return { ok: false, problem, stageId: profile.instance_id };
        return {
          ok: true,
          record: recordOf(profile, readAt),
          adminApiUrl: setup.adminUrls?.[profile.name] ?? `${LINK_URL}/`,
        };
      },
    },
    link: { storedLink: async () => link },
    retirements,
    events,
    clock,
    send: async (request) => {
      sent.push(request);
      return setup.answer ? setup.answer(request) : request.kind === 'store' ? 'stored' : 'retired';
    },
  });
  return { publisher, clock, events, profiles, sent, builds, link, retirements };
}

function changed(events: EventBus, profile: ProfileWithContainers): void {
  events.publish({ type: 'profile.changed', profile });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function logLines(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ['info', 'warn', 'error', 'log'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

describe('when a change is pushed', () => {
  it('gathers a burst of change events for one deployment into one push, a short while after the first', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles, sent } = publisherFor();
    publisher.start();
    t.after(() => publisher.stop());
    const profile = profiles.get('stage-one')!;

    changed(events, profile);
    changed(events, profile);
    changed(events, profile);
    await clock.advance(STAGE_PUSH_DEBOUNCE_MS - 1);
    assert.equal(sent.length, 0, 'nothing yet');
    await clock.advance(1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, 'store');
  });

  it('keeps two deployments apart', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles, sent } = publisherFor({
      profiles: [stage('stage-one', 1), stage('stage-two', 2)],
    });
    publisher.start();
    t.after(() => publisher.stop());
    changed(events, profiles.get('stage-one')!);
    changed(events, profiles.get('stage-two')!);
    await clock.advance(STAGE_PUSH_DEBOUNCE_MS);
    assert.deepEqual(sent.map((request) => (request.kind === 'store' ? request.record.name : '')).sort(), [
      'stage-one',
      'stage-two',
    ]);
  });

  it('pays no attention to a deployment that runs no uploader', async (t) => {
    logLines(t);
    const viewer = stage('viewer-one', 3, { kind: 'viewer' });
    const { publisher, clock, events, sent } = publisherFor({ profiles: [viewer] });
    publisher.start();
    t.after(() => publisher.stop());
    changed(events, viewer);
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.equal(sent.length, 0);
  });

  it('does not double a push in flight: one more follows it, however many triggers came', async (t) => {
    logLines(t);
    const gate = deferred<StagePushOutcome>();
    let calls = 0;
    const { publisher, sent } = publisherFor({
      answer: () => {
        calls += 1;
        return calls === 1 ? gate.promise : 'stored';
      },
    });

    const first = publisher.pushNow('stage-one');
    await settle();
    const second = publisher.pushNow('stage-one');
    const third = publisher.pushNow('stage-one');
    const skipped = publisher.pushNow('stage-one', 'skip');
    await settle();
    assert.equal(sent.length, 1, 'still the one in flight');

    gate.resolve('stored');
    assert.equal(await first, 'stored');
    assert.equal(await skipped, 'stored');
    assert.equal(await second, 'stored');
    assert.equal(await third, 'stored');
    await settle();
    assert.equal(sent.length, 2, 'the one in flight and one after it');
  });
});

describe('the cadence', () => {
  it('pushes every running stage every 30 seconds, and no stopped one', async (t) => {
    logLines(t);
    const { publisher, clock, sent } = publisherFor({
      profiles: [stage('running', 1), stage('stopped', 2, { status: 'STOPPED' })],
    });
    publisher.start();
    t.after(() => publisher.stop());

    await clock.advance(STAGE_PUSH_INTERVAL_MS - 1);
    assert.equal(sent.length, 0);
    await clock.advance(1);
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    const names = sent.map((request) => (request.kind === 'store' ? request.record.name : ''));
    assert.deepEqual(names, ['running', 'running']);
  });

  it('stops with the publisher', async (t) => {
    logLines(t);
    const { publisher, clock, sent } = publisherFor();
    publisher.start();
    publisher.stop();
    await clock.advance(STAGE_PUSH_INTERVAL_MS * 3);
    assert.equal(sent.length, 0);
  });
});

describe('to whom', () => {
  it('pushes to the link with its token when the deployment reports to the link’s origin, any path', async (t) => {
    logLines(t);
    const { publisher, sent } = publisherFor({ adminUrls: { 'stage-one': 'https://ADMIN.example.org:443/some/path' } });
    assert.equal(await publisher.pushNow('stage-one'), 'stored');
    assert.equal(sent[0]!.baseUrl, LINK_URL);
    assert.equal(sent[0]!.token, LINK_TOKEN);
  });

  it('skips a deployment that reports to another origin, and says so', async (t) => {
    logLines(t);
    for (const other of ['https://other.example.org', 'http://admin.example.org', 'https://admin.example.org:8443']) {
      const { publisher, sent } = publisherFor({ adminUrls: { 'stage-one': other } });
      assert.equal(await publisher.pushNow('stage-one'), 'skipped-other-origin', other);
      assert.equal(sent.length, 0);
      assert.equal(publisher.lastPush('stage-one')?.outcome, 'skipped-other-origin');
    }
  });

  it('skips a deployment that is not linked at all', async (t) => {
    logLines(t);
    const { publisher, sent } = publisherFor({ adminUrls: { 'stage-one': '' } });
    assert.equal(await publisher.pushNow('stage-one'), 'skipped-not-linked');
    assert.equal(sent.length, 0);
  });

  it('pushes nothing while the link has no token, or no address', async (t) => {
    logLines(t);
    for (const link of [
      { url: LINK_URL, token: null },
      { url: null, token: null },
    ]) {
      const { publisher, sent, builds } = publisherFor({ link });
      assert.equal(await publisher.pushNow('stage-one'), 'skipped-no-link');
      assert.equal(sent.length, 0);
      assert.equal(builds.length, 0, 'no readings taken for nothing');
    }
  });

  it('skips a record that cannot be put together, and logs why once', async (t) => {
    const lines = logLines(t);
    const { publisher, sent } = publisherFor({
      problems: { 'stage-one': 'The next deploy gives the uploader no stream key.' },
    });
    assert.equal(await publisher.pushNow('stage-one'), 'skipped-no-record');
    assert.equal(await publisher.pushNow('stage-one'), 'skipped-no-record');
    assert.equal(sent.length, 0);
    assert.equal(lines.filter((line) => line.includes('no stream key')).length, 1);
  });
});

describe('what a push leaves', () => {
  it('keeps the last outcome with its time', async (t) => {
    logLines(t);
    const { publisher, clock } = publisherFor({ answer: () => 'refused-token' });
    assert.equal(publisher.lastPush('stage-one'), null);
    await publisher.pushNow('stage-one');
    assert.deepEqual(publisher.lastPush('stage-one'), {
      outcome: 'refused-token',
      at: new Date(clock.time).toISOString(),
    });
  });

  it('logs an outcome when it changes, and never the address, the token or the passphrase', async (t) => {
    const lines = logLines(t);
    const outcomes: StagePushOutcome[] = ['stored', 'stored', 'unreachable'];
    const { publisher } = publisherFor({ answer: () => outcomes.shift() ?? 'stored' });
    await publisher.pushNow('stage-one');
    await publisher.pushNow('stage-one');
    await publisher.pushNow('stage-one');
    const pushes = lines.filter((line) => line.includes('[Stages]'));
    assert.equal(pushes.length, 2, pushes.join('\n'));
    assert.match(pushes[0]!, /stage-one.*stored/);
    assert.match(pushes[1]!, /stage-one.*unreachable/);
    for (const line of lines) {
      assert.ok(!line.includes(LINK_TOKEN) && !line.includes('admin.example.org') && !line.includes(PASSPHRASE), line);
    }
  });
});

describe('a deployment that goes', () => {
  it('retires its stage at the link its records went to, with the moment it was seen gone', async (t) => {
    logLines(t);
    const { publisher, clock, events, sent } = publisherFor();
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');

    events.publish(removal('stage-one', 1, clock));
    await settle();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], {
      kind: 'retire',
      baseUrl: LINK_URL,
      token: LINK_TOKEN,
      stageId: idOf(1),
      observedAt: new Date(clock.time).toISOString(),
    });
    assert.equal(publisher.lastPush('stage-one'), null, 'nothing kept of it');
  });

  it('retires nothing it skipped, and nothing it never saw', async (t) => {
    logLines(t);
    const { publisher, events, sent, retirements } = publisherFor({
      adminUrls: { 'stage-one': 'https://other.example.org' },
    });
    // The row the deletion leaves for every stage, which the publisher's decision takes out again.
    retirements.rows.set(idOf(1), { stageId: idOf(1), name: 'stage-one', deletedAt: null, origin: null });
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    events.publish(removal('stage-one', 1));
    events.publish(removal('never-a-stage', 2, undefined, 'custom'));
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(retirements.rows.size, 0, 'nothing left pending');
  });

  it('retires a stage removed before this manager pushed it since it started, by the id the removal carries', async (t) => {
    const lines = logLines(t);
    const { publisher, clock, events, sent } = publisherFor({ profiles: [] });
    publisher.start();
    t.after(() => publisher.stop());
    await clock.advance(5_000);
    const deletedAt = new Date(clock.time - 2_000).toISOString();
    events.publish({ ...removal('pushed-before-a-restart', 7), deletedAt });
    await settle();
    assert.deepEqual(sent, [
      { kind: 'retire', baseUrl: LINK_URL, token: LINK_TOKEN, stageId: idOf(7), observedAt: deletedAt },
    ]);
    assert.equal(publisher.keeps('pushed-before-a-restart'), false);
    for (const line of lines) assert.ok(!line.includes(LINK_TOKEN) && !line.includes('admin.example.org'), line);
  });

  it('retires one it never pushed only at a link that stores a token', async (t) => {
    logLines(t);
    const unlinked = publisherFor({ profiles: [], link: { url: LINK_URL, token: null } });
    unlinked.publisher.start();
    t.after(() => unlinked.publisher.stop());
    unlinked.events.publish(removal('stage-two', 2));
    await settle();
    assert.equal(unlinked.sent.length, 0);
  });

  it('cancels a push it had gathered, and retires the stage all the same, which the admin keeps as a tombstone', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles, sent } = publisherFor();
    publisher.start();
    t.after(() => publisher.stop());
    changed(events, profiles.get('stage-one')!);
    events.publish(removal('stage-one', 1, clock));
    profiles.delete('stage-one');
    await clock.advance(STAGE_PUSH_DEBOUNCE_MS);
    assert.deepEqual(
      sent.map((request) => [request.kind, request.kind === 'retire' ? request.stageId : '']),
      [['retire', idOf(1)]],
    );
  });
});

describe('the moment a record says it was observed', () => {
  it('is taken before the slower readings, and a removal seen meanwhile is later than it', async (t) => {
    logLines(t);
    const slow = deferred<void>();
    let building = false;
    const { publisher, clock, events, sent } = publisherFor({
      duringBuild: async () => {
        building = true;
        await slow.promise;
      },
    });
    publisher.start();
    t.after(() => publisher.stop());
    const push = publisher.pushNow('stage-one');
    await settle();
    assert.ok(building);
    const readAt = clock.time;

    await clock.advance(5_000);
    events.publish(removal('stage-one', 1, clock));
    slow.resolve();
    await push;
    await settle();

    const stored = sent.find((request) => request.kind === 'store') as Extract<StageRequest, { kind: 'store' }>;
    const retired = sent.find((request) => request.kind === 'retire') as Extract<StageRequest, { kind: 'retire' }>;
    assert.equal(stored.record.observedAt, new Date(readAt).toISOString());
    assert.ok(retired, 'the stage was retired once the push that outlived it had gone');
    assert.ok(Date.parse(retired.observedAt) > Date.parse(stored.record.observedAt));
  });
});

describe('before a deploy starts the uploader', () => {
  it('pushes the record then, after a push already in flight', async (t) => {
    logLines(t);
    const gate = deferred<StagePushOutcome>();
    let calls = 0;
    const { publisher, sent } = publisherFor({
      answer: () => {
        calls += 1;
        return calls === 1 ? gate.promise : 'stored';
      },
    });
    const inFlight = publisher.pushNow('stage-one');
    await settle();
    const hook = publisher.beforeUploaderStart({ name: 'stage-one', kind: 'streamer' });
    await settle();
    gate.resolve('stored');
    await inFlight;
    await hook;
    assert.equal(sent.length, 2, 'the hook’s own push followed the one in flight');
  });

  it('never throws, whatever the push comes to', async (t) => {
    const lines = logLines(t);
    const { publisher } = publisherFor({
      answer: () => {
        throw new Error('socket hang up');
      },
    });
    await publisher.beforeUploaderStart({ name: 'stage-one', kind: 'streamer' });
    assert.ok(lines.some((line) => /stage-one/.test(line)));

    const refused = publisherFor({ answer: () => 'refused-token' });
    await refused.publisher.beforeUploaderStart({ name: 'stage-one', kind: 'streamer' });
  });

  it('does nothing for a kind that runs no uploader', async (t) => {
    logLines(t);
    const { publisher, sent } = publisherFor();
    await publisher.beforeUploaderStart({ name: 'stage-one', kind: 'viewer' });
    assert.equal(sent.length, 0);
  });
});

describe('the console’s read', () => {
  it('answers every stage’s record without its passphrase, with its last push', async (t) => {
    logLines(t);
    const { publisher } = publisherFor({
      profiles: [stage('stage-one', 1), stage('broken', 2), stage('viewer', 3, { kind: 'viewer' })],
      problems: { broken: 'The version has no build yet.' },
    });
    await publisher.pushNow('stage-one');
    const stages = await publisher.consoleStages();
    assert.deepEqual(
      stages.map((entry) => entry.name),
      ['stage-one', 'broken'],
    );
    const [one, broken] = stages;
    assert.equal(one!.record?.ingest.hasSrtPassphrase, true);
    assert.ok(!('srtPassphrase' in (one!.record?.ingest ?? {})));
    assert.ok(!JSON.stringify(stages).includes(PASSPHRASE));
    assert.equal(one!.lastPush?.outcome, 'stored');
    assert.equal(broken!.record, null);
    assert.equal(broken!.problem, 'The version has no build yet.');
    assert.equal(broken!.lastPush, null);
  });

  it('answers the admin token by its kind alone, never its sha256', () => {
    const sha256 = 'ab'.repeat(32);
    const pushed = consoleRecordOf({
      ...recordOf(stage('stage-one', 1)),
      adminToken: { sha256, kind: 'own' },
    });
    assert.deepEqual(pushed.adminToken, { kind: 'own' });
    assert.ok(!JSON.stringify(pushed).includes(sha256));
    assert.equal(consoleRecordOf(recordOf(stage('stage-one', 1))).adminToken, null);
  });
});

describe('the pre-start push’s bound', () => {
  it('gives up after ten seconds on a push that hangs, says so, and lets the deploy go on', async (t) => {
    const lines = logLines(t);
    const never = deferred<StagePushOutcome>();
    const { publisher, clock, sent } = publisherFor({ answer: () => never.promise });
    let returned = false;
    const hook = publisher.beforeUploaderStart({ name: 'stage-one', kind: 'streamer' }).then(() => {
      returned = true;
    });
    await settle();
    assert.equal(sent.length, 1, 'the push was sent and hangs');

    await clock.advance(STAGE_PUSH_BEFORE_START_MS - 1);
    assert.equal(returned, false, 'still waiting within the bound');
    await clock.advance(1);
    await hook;
    assert.equal(returned, true);
    assert.ok(
      lines.some((line) => /stage-one.*took too long/.test(line)),
      lines.join('\n'),
    );
  });
});

describe('a retirement after the link moved', () => {
  it('sends nothing, and the token never goes to the new origin', async (t) => {
    const lines = logLines(t);
    const { publisher, events, sent, link } = publisherFor();
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    assert.equal(sent.length, 1);

    link.url = 'https://other-admin.example.org';
    link.token = 'synthetic-other-registrar-token-0123456789';
    events.publish(removal('stage-one', 1));
    await settle();

    assert.equal(sent.length, 1, 'no retirement was sent');
    assert.ok(sent.every((request) => request.baseUrl === LINK_URL && request.token === LINK_TOKEN));
    assert.ok(lines.some((line) => /stage-one.*not retired.*link has changed/.test(line)));
  });
});

describe('a retirement the admin has not answered', () => {
  /** A deployment pushed once and then removed, whose first retirement comes to `first`. */
  async function removedAfterOnePush(t: TestContext, first: StagePushOutcome, retirements?: FakeRetirements) {
    const lines = logLines(t);
    const answers: StagePushOutcome[] = [first];
    const setup = publisherFor({
      retirements,
      answer: (request) => (request.kind === 'store' ? 'stored' : (answers.shift() ?? 'retired')),
    });
    setup.publisher.start();
    t.after(() => setup.publisher.stop());
    await setup.publisher.pushNow('stage-one');
    setup.profiles.delete('stage-one');
    setup.events.publish(removal('stage-one', 1, setup.clock));
    await settle();
    const retires = () => setup.sent.filter((request) => request.kind === 'retire');
    return { ...setup, lines, retires, deletedAt: new Date(setup.clock.time).toISOString() };
  }

  it('is sent again on the next tick, with the same moment, and forgotten once the admin answers', async (t) => {
    const { clock, retires, retirements, deletedAt } = await removedAfterOnePush(t, 'unreachable');
    assert.equal(retires().length, 1);
    assert.deepEqual(
      [...retirements.rows.values()],
      [{ stageId: idOf(1), name: 'stage-one', deletedAt, origin: 'https://admin.example.org' }],
    );

    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.equal(retires().length, 2);
    assert.deepEqual(retires()[1], {
      kind: 'retire',
      baseUrl: LINK_URL,
      token: LINK_TOKEN,
      stageId: idOf(1),
      observedAt: deletedAt,
    });
    assert.equal(retirements.rows.size, 0, 'answered, so nothing is left pending');

    await clock.advance(STAGE_PUSH_INTERVAL_MS * 2);
    assert.equal(retires().length, 2, 'never sent again');
  });

  it('is forgotten when the admin answers that it held no such stage', async (t) => {
    const { retires, retirements } = await removedAfterOnePush(t, 'not-retired');
    assert.equal(retires().length, 1);
    assert.equal(retirements.rows.size, 0);
  });

  it('says once that it keeps failing, not every 30 seconds', async (t) => {
    const lines = logLines(t);
    const { publisher, clock, events, profiles, sent } = publisherFor({
      answer: (request) => (request.kind === 'store' ? 'stored' : 'unreachable'),
    });
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    profiles.delete('stage-one');
    events.publish(removal('stage-one', 1, clock));
    await settle();
    await clock.advance(STAGE_PUSH_INTERVAL_MS * 3);
    assert.equal(sent.filter((request) => request.kind === 'retire').length, 4);
    assert.equal(
      lines.filter((line) => /stage-one: removed, and retiring its stage came to unreachable/.test(line)).length,
      1,
    );
  });

  it('survives a restart: the next publisher sends it at start, as of the moment the first saw it gone', async (t) => {
    const retirements = new FakeRetirements();
    const first = await removedAfterOnePush(t, 'unreachable', retirements);
    first.publisher.stop();

    logLines(t);
    const next = publisherFor({ profiles: [], retirements });
    next.publisher.start();
    t.after(() => next.publisher.stop());
    await settle();
    assert.deepEqual(next.sent, [
      { kind: 'retire', baseUrl: LINK_URL, token: LINK_TOKEN, stageId: idOf(1), observedAt: first.deletedAt },
    ]);
    assert.equal(retirements.rows.size, 0);
  });

  it('retires one the deletion left before any decision, by its id at the current link, as of when it is found', async (t) => {
    logLines(t);
    const retirements = new FakeRetirements();
    retirements.rows.set(idOf(3), { stageId: idOf(3), name: 'stage-three', deletedAt: null, origin: null });
    const { publisher, clock, sent } = publisherFor({ profiles: [], retirements });
    publisher.start();
    t.after(() => publisher.stop());
    await settle();
    assert.deepEqual(sent, [
      {
        kind: 'retire',
        baseUrl: LINK_URL,
        token: LINK_TOKEN,
        stageId: idOf(3),
        observedAt: new Date(clock.time).toISOString(),
      },
    ]);
    assert.equal(retirements.rows.size, 0);
  });

  it('drops one whose link has moved to another origin since, and says so', async (t) => {
    const lines = logLines(t);
    const retirements = new FakeRetirements();
    const deletedAt = '2026-09-28T09:00:00.000Z';
    retirements.rows.set(idOf(4), {
      stageId: idOf(4),
      name: 'stage-four',
      deletedAt,
      origin: 'https://old-admin.example.org',
    });
    const { publisher, sent } = publisherFor({ profiles: [], retirements });
    publisher.start();
    t.after(() => publisher.stop());
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(retirements.rows.size, 0);
    assert.ok(lines.some((line) => /stage-four.*not retired.*link has changed/.test(line)));
  });

  it('waits while the link has no token, and is sent once it has one', async (t) => {
    logLines(t);
    const retirements = new FakeRetirements();
    const deletedAt = '2026-09-28T09:00:00.000Z';
    retirements.rows.set(idOf(5), {
      stageId: idOf(5),
      name: 'stage-five',
      deletedAt,
      origin: 'https://admin.example.org',
    });
    const { publisher, clock, sent, link } = publisherFor({
      profiles: [],
      retirements,
      link: { url: LINK_URL, token: null },
    });
    publisher.start();
    t.after(() => publisher.stop());
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.equal(sent.length, 0);
    assert.equal(retirements.rows.size, 1, 'still pending');

    link.token = LINK_TOKEN;
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.deepEqual(sent, [
      { kind: 'retire', baseUrl: LINK_URL, token: LINK_TOKEN, stageId: idOf(5), observedAt: deletedAt },
    ]);
    assert.equal(retirements.rows.size, 0);
  });

  it('is kept for one whose pushes the plain http rule stopped, which the admin may hold from before it', async (t) => {
    logLines(t);
    let plainHttp = true;
    const { publisher, clock, events, profiles, sent, retirements } = publisherFor({
      answer: (request) => (plainHttp ? 'refused-plain-http' : request.kind === 'store' ? 'stored' : 'retired'),
    });
    publisher.start();
    t.after(() => publisher.stop());
    assert.equal(await publisher.pushNow('stage-one'), 'refused-plain-http');
    profiles.delete('stage-one');
    events.publish(removal('stage-one', 1, clock));
    await settle();
    assert.equal(sent.filter((request) => request.kind === 'retire').length, 1);
    assert.equal(retirements.rows.size, 1, 'kept until the link can take it');

    plainHttp = false;
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.equal(sent.filter((request) => request.kind === 'retire').length, 2);
    assert.equal(retirements.rows.size, 0);
  });

  it('is kept for one pushed while the link had no token, cleared to rotate it, and sent once it has one', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles, sent, retirements, link } = publisherFor({
      link: { url: LINK_URL, token: null },
    });
    publisher.start();
    t.after(() => publisher.stop());
    assert.equal(await publisher.pushNow('stage-one'), 'skipped-no-link');
    profiles.delete('stage-one');
    events.publish(removal('stage-one', 1, clock));
    await settle();
    assert.equal(sent.length, 0);
    assert.deepEqual(
      [...retirements.rows.values()],
      [{ stageId: idOf(1), name: 'stage-one', deletedAt: new Date(clock.time).toISOString(), origin: null }],
    );

    link.token = LINK_TOKEN;
    await clock.advance(STAGE_PUSH_INTERVAL_MS);
    assert.deepEqual(
      sent.map((request) => [request.kind, request.kind === 'retire' ? request.stageId : '']),
      [['retire', idOf(1)]],
    );
    assert.equal(retirements.rows.size, 0);
  });

  it('is not doubled while one is in flight', async (t) => {
    logLines(t);
    const gate = deferred<StagePushOutcome>();
    const { publisher, clock, events, profiles, sent, retirements } = publisherFor({
      answer: (request) => (request.kind === 'store' ? 'stored' : gate.promise),
    });
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    profiles.delete('stage-one');
    events.publish(removal('stage-one', 1, clock));
    await clock.advance(STAGE_PUSH_INTERVAL_MS * 2);
    assert.equal(sent.filter((request) => request.kind === 'retire').length, 1);
    gate.resolve('retired');
    await settle();
    assert.equal(retirements.rows.size, 0);
  });
});

describe('after stop', () => {
  it('starts no push: not a change, not the cadence, not a follow-up, not the pre-start hook', async (t) => {
    logLines(t);
    const gate = deferred<StagePushOutcome>();
    const { publisher, clock, events, profiles, sent } = publisherFor({ answer: () => gate.promise });
    publisher.start();
    const inFlight = publisher.pushNow('stage-one');
    await settle();
    void publisher.pushNow('stage-one', 'follow');
    changed(events, profiles.get('stage-one')!);
    publisher.stop();

    gate.resolve('stored');
    await inFlight;
    assert.equal(await publisher.pushNow('stage-one'), null);
    await publisher.beforeUploaderStart({ name: 'stage-one', kind: 'streamer' });
    changed(events, profiles.get('stage-one')!);
    await clock.advance(STAGE_PUSH_INTERVAL_MS * 2);
    publisher.start();
    await clock.advance(STAGE_PUSH_INTERVAL_MS * 2);

    assert.equal(sent.length, 1, 'only the push that was already in flight');
  });
});

describe('what the publisher keeps', () => {
  it('drops a name that is gone and was never pushed nor seen', async (t) => {
    logLines(t);
    const { publisher } = publisherFor({ profiles: [] });
    assert.equal(await publisher.pushNow('gone-stage'), null);
    assert.equal(publisher.keeps('gone-stage'), false);
  });

  it('keeps one it pushed, and one a change event named, until its removal retires it', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles } = publisherFor({
      profiles: [stage('stage-one', 1), stage('stage-two', 2)],
    });
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    // stage-two is never pushed: it is gone by the time the push its change event gathered runs.
    changed(events, profiles.get('stage-two')!);
    profiles.delete('stage-one');
    profiles.delete('stage-two');
    assert.equal(await publisher.pushNow('stage-one'), null);
    await clock.advance(STAGE_PUSH_DEBOUNCE_MS);
    assert.equal(publisher.keeps('stage-one'), true, 'kept for its retirement');
    assert.equal(publisher.keeps('stage-two'), true, 'kept for its retirement');
    events.publish(removal('stage-one', 1));
    events.publish(removal('stage-two', 2));
    await settle();
    assert.equal(publisher.keeps('stage-one'), false);
    assert.equal(publisher.keeps('stage-two'), false);
  });
});
