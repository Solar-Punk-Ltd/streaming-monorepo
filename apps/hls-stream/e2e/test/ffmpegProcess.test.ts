import assert from 'node:assert/strict';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { startFfmpeg } from '../src/harness/ffmpegProcess.js';

/**
 * A stand-in for the encoder, built on a real `EventEmitter` rather than on a hand-rolled listener
 * map. The behaviour under test is Node's own: emitting `error` with nothing listening for it throws
 * out of the `emit` call and takes the run down. A double that merely recorded listeners would report
 * that as safe, which is the one answer it must not be able to give.
 */
class FakeFfmpeg extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
}

function startWith(fake: FakeFfmpeg, stopGraceMs = 20) {
  return startFfmpeg(['-i', 'anything'], {
    stopGraceMs,
    spawnFn: (() => fake as unknown as ChildProcess) as unknown as typeof nodeSpawn,
  });
}

describe('supervising the encoder', () => {
  it('accumulates whatever ffmpeg wrote to stderr', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    fake.stderr.emit('data', Buffer.from('Connection refused'));
    fake.stderr.emit('data', Buffer.from(' by peer'));

    assert.equal(proc.stderr(), 'Connection refused by peer');
  });

  /**
   * The defect. A spawn that never happens does not write to stderr, it emits `error`, and an
   * emitter with no listener for that throws where it is emitted. Node raises it from inside its own
   * internals, so it does not surface as a failed publish, it ends the whole run with a stack trace
   * about the wrong thing. A missing ffmpeg binary is the ordinary way to reach it.
   */
  it('records a spawn failure rather than letting it take the run down', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    fake.emit('error', new Error('spawn ffmpeg ENOENT'));

    assert.match(proc.stderr(), /ENOENT/);
    assert.deepEqual(proc.exit(), { code: null, signal: null });
  });

  it('has no exit status while it is still running', () => {
    assert.equal(startWith(new FakeFfmpeg()).exit(), null);
  });

  /**
   * A publish that died on its arguments and a publish still running are the same object to a caller
   * that cannot ask. The status is what lets one wait be cut short rather than spent.
   */
  it('records the status a finished process ended with', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    fake.emit('exit', 1, null);

    assert.deepEqual(proc.exit(), { code: 1, signal: null });
  });

  it('records the signal that ended it, when a signal did', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    fake.emit('exit', null, 'SIGKILL');

    assert.deepEqual(proc.exit(), { code: null, signal: 'SIGKILL' });
  });

  it('interrupts a running process, and stops once it goes', async () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    const stopped = proc.stop();
    fake.emit('exit', 0, null);
    await stopped;

    assert.deepEqual(fake.signals, ['SIGINT']);
  });

  it('kills a process that ignored the interrupt', async () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake, 5);

    await proc.stop();

    assert.deepEqual(fake.signals, ['SIGINT', 'SIGKILL']);
  });

  it('signals nothing at all when the process has already gone', async () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);
    fake.emit('exit', 0, null);

    await proc.stop();

    assert.deepEqual(fake.signals, []);
  });
});

/**
 * An encoder whose network died without closing its connection, which is what the engine's takeover exists for.
 *
 * Stopping the process where it stands is the one way to make that from this side: the socket stays open, so the
 * engine sees a publisher that went silent rather than one that left. A clean `stop` closes the connection and a
 * kill closes it too, so neither can stand in for it.
 */
describe('freezing the encoder', () => {
  it('stops the process without ending it', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);

    proc.freeze();

    assert.deepEqual(fake.signals, ['SIGSTOP']);
    assert.equal(proc.exit(), null, 'a frozen encoder is still there, holding its connection open');
  });

  /** A stopped process holds an interrupt until it runs again, so the interrupt is followed by a continue. */
  it('lets the interrupt land when a frozen process is stopped', async () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);
    proc.freeze();

    const stopped = proc.stop();
    fake.emit('exit', 255, null);
    await stopped;

    assert.deepEqual(fake.signals, ['SIGSTOP', 'SIGINT', 'SIGCONT']);
  });

  it('still kills a frozen process that does not go', async () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake, 5);
    proc.freeze();

    await proc.stop();

    assert.deepEqual(fake.signals, ['SIGSTOP', 'SIGINT', 'SIGCONT', 'SIGKILL']);
  });

  it('signals nothing when the process it would freeze has already gone', () => {
    const fake = new FakeFfmpeg();
    const proc = startWith(fake);
    fake.emit('exit', 1, null);

    proc.freeze();

    assert.deepEqual(fake.signals, []);
  });
});
