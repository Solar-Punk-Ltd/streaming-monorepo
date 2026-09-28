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

import { EventBus } from '../../src/domain/EventBus.js';
import type { BuiltStage } from '../../src/domain/stages/StageRecordBuilder.js';
import {
  STAGE_PUSH_DEBOUNCE_MS,
  STAGE_PUSH_INTERVAL_MS,
  StagePublisher,
  type StageClock,
} from '../../src/domain/stages/StagePublisher.js';
import type { StageRequest } from '../../src/domain/stages/stageRequest.js';
import type { ProfileWithContainers } from '../../src/types/index.js';
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

interface Setup {
  profiles?: ProfileWithContainers[];
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
  const link = setup.link ?? { url: LINK_URL, token: LINK_TOKEN };
  const sent: StageRequest[] = [];
  const builds: string[] = [];
  const publisher = new StagePublisher({
    profiles: {
      list: async () => [...profiles.values()],
      find: async (name) => profiles.get(name) ?? null,
    },
    builder: {
      async build(profile, _link, readAt): Promise<BuiltStage> {
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
    events,
    clock,
    send: async (request) => {
      sent.push(request);
      return setup.answer ? setup.answer(request) : request.kind === 'store' ? 'stored' : 'retired';
    },
  });
  return { publisher, clock, events, profiles, sent, builds };
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

    events.publish({ type: 'profile.deleted', name: 'stage-one' });
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
    const { publisher, events, sent } = publisherFor({ adminUrls: { 'stage-one': 'https://other.example.org' } });
    publisher.start();
    t.after(() => publisher.stop());
    await publisher.pushNow('stage-one');
    events.publish({ type: 'profile.deleted', name: 'stage-one' });
    events.publish({ type: 'profile.deleted', name: 'never-seen' });
    await settle();
    assert.equal(sent.length, 0);
  });

  it('cancels a push it had gathered, and retires the stage all the same, which the admin keeps as a tombstone', async (t) => {
    logLines(t);
    const { publisher, clock, events, profiles, sent } = publisherFor();
    publisher.start();
    t.after(() => publisher.stop());
    changed(events, profiles.get('stage-one')!);
    events.publish({ type: 'profile.deleted', name: 'stage-one' });
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
    events.publish({ type: 'profile.deleted', name: 'stage-one' });
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
});
