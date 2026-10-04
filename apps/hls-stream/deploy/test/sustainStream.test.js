import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ The probe used to hardcode one owner and topic, and every in-browser sitting before it changed
 * ran against it without anyone ever choosing it. That stream was a latency bench profile, not what
 * the product ships, and the results were written up as being about the product. So the stream is
 * not a convenience: the operator names it and its shape, and an unset or incomplete stream throws
 * rather than falling back to anything at all.
 *
 * The probe is a self-executing browser script by design, pasted or fetched into a console, so there
 * is nothing to import. It is evaluated here with the three globals it touches before it would reach
 * the network.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../scripts/in-browser-sustain.js', import.meta.url)), 'utf-8');

/** A stream as an operator names it. Synthetic: no feed lives at this owner and topic. */
const STREAM = Object.freeze({
  name: 'vod-sample',
  owner: '00000000000000000000000000000000000000aa',
  topic: 'a'.repeat(64),
  segmentSeconds: 4.166667,
  segmentKB: 4241,
});

const BYTES_PER_KB = 1024;
const BITS_PER_BYTE = 8;
/** Bitrates are decimal megabits by convention, while the KB beside them is binary. Mixing the two
 * moves a figure by 4.9%, which is small enough to look like a rounding difference and be kept. */
const BITS_PER_MEGABIT = 1e6;

/**
 * Runs the probe against stub globals and returns what the console would have seen.
 *
 * `querySelectorAll` returning nothing is deliberate: with peers already full the script goes
 * straight on to attach a stream, finds no navigation input, and records the failure on `__sustain`
 * instead of opening a socket. Every assertion here is about what happened before that point.
 */
function arm(window, { visible = true } = {}) {
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    body: { innerText: 'Connected: 200 Connecting: 0' },
    querySelectorAll: () => [],
  };
  const console = { log: () => {}, error: () => {} };
  // Bound to a name rather than returned directly: the probe opens with a comment block, and
  // `return` followed by a line terminator is `return;`, so the script would never run at all.
  const body = `const armed = ${SOURCE}\nreturn armed;`;
  const value = new Function('window', 'document', 'console', body)(window, document, console);
  return { value, sustain: window.__sustain };
}

describe('in-browser sustain probe, choosing a stream', () => {
  it('refuses to run when no stream is named', () => {
    assert.throws(() => arm({}), /Refusing to run: set window\.__sustainStream/);
  });

  it('names every field it needs in the refusal, so the fix is in the error', () => {
    assert.throws(() => arm({}), /name.*owner.*topic.*segmentSeconds.*segmentKB/);
  });

  it('refuses a stream named by a bare string, which no longer selects from a table', () => {
    assert.throws(() => arm({ __sustainStream: 'vod-sample' }), /Refusing to run/);
  });

  for (const [field, value] of [
    ['name', ''],
    ['owner', 'not-hex'],
    ['topic', ''],
    ['segmentSeconds', 0],
    ['segmentKB', -1],
  ]) {
    it(`refuses a stream whose ${field} is unusable`, () => {
      assert.throws(
        () => arm({ __sustainStream: { ...STREAM, [field]: value } }),
        new RegExp(`Refusing to run.*${field}`),
      );
    });
  }

  it('still refuses a hidden document once a stream is named', () => {
    assert.throws(() => arm({ __sustainStream: STREAM }, { visible: false }), /document is not visible/);
  });

  it('reports which stream it armed on and the bitrate its shape implies, so a pasted result carries its scope', () => {
    const { value } = arm({ __sustainStream: STREAM });

    assert.match(value, /armed on 'vod-sample'/);
    assert.match(value, /8\.34 Mbps/);
  });

  it('records the stream on the object the raw samples are saved from', () => {
    const { sustain } = arm({ __sustainStream: STREAM });

    assert.equal(sustain.stream.name, 'vod-sample');
    assert.equal(sustain.stream.owner, STREAM.owner);
    assert.equal(sustain.stream.segmentSeconds, 4.166667);
  });

  it('carries the operator note into what it prints', () => {
    const { sustain } = arm({ __sustainStream: { ...STREAM, note: 'shape assumed from a replicate' } });

    assert.match(sustain.stream.what, /shape assumed from a replicate/);
  });
});

/** A sample in the shape the probe records, one per wall second. */
const at = (t, ct, extra = {}) => ({ t, ct, rs: 4, paused: false, buffEnd: ct + 10, ...extra });

/** Drives the summary over a prepared set of samples, as a finished run would. */
function summarise(samples, { firstAdvanceAt = 0, stream = STREAM } = {}) {
  const { sustain } = arm({ __sustainStream: stream });
  sustain.samples = samples;
  sustain.firstAdvanceAt = firstAdvanceAt;
  return sustain.summarise();
}

describe('in-browser sustain probe, scoring a run', () => {
  it('does not charge time before the first frame against the stream', () => {
    // Five seconds of startup, then a playhead that keeps perfect time.
    const samples = [at(0, 0, { rs: 0 }), at(5000, 0, { rs: 0 }), at(6000, 1), at(105000, 100)];

    const summary = summarise(samples, { firstAdvanceAt: 6000 });

    assert.equal(summary.realtimeRatio, 1);
    assert.ok(summary.realtimeRatioWithStartup < 1, 'the unadjusted figure still carries startup');
  });

  it('counts seconds lost to a playhead that advances slowly but never quite stops', () => {
    // 0.9s of playhead per wall second: no sample ever repeats, so nothing reads as a stall.
    const samples = Array.from({ length: 101 }, (_, i) => at(i * 1000, i * 0.9));

    const summary = summarise(samples, { firstAdvanceAt: 0 });

    assert.equal(summary.stallCount, 0);
    assert.equal(summary.realtimeRatio, 0.9);
    assert.equal(summary.lostS, 10);
  });

  it('reports the stream and its demand beside the ratio', () => {
    const summary = summarise([at(0, 0), at(100000, 100)], { firstAdvanceAt: 0 });

    assert.equal(summary.stream, 'vod-sample');
    assert.equal(summary.demandedKBps, 1018);
    assert.equal(summary.derivedDeliveredKBps, 1018);
  });
});

describe('in-browser sustain probe, the bitrate it states', () => {
  /**
   * The bitrate in the description is what a reader quotes, and the two numbers beside it are what
   * the summary divides to state the demand. It is computed from them, so the two cannot disagree.
   */
  for (const shape of [STREAM, { ...STREAM, name: 'short-segments', segmentSeconds: 0.5, segmentKB: 120 }]) {
    it(`states a bitrate for ${shape.name} that its own segment figures produce`, () => {
      const { stream } = arm({ __sustainStream: shape }).sustain;
      const claimed = Number(stream.what.match(/([\d.]+) Mbps/)[1]);

      const derived = (stream.segmentKB * BYTES_PER_KB * BITS_PER_BYTE) / BITS_PER_MEGABIT / stream.segmentSeconds;

      assert.ok(
        Math.abs(derived - claimed) / claimed < 0.02,
        `${shape.name}: description says ${claimed} Mbps, segments give ${derived.toFixed(2)}`,
      );
    });
  }
});
