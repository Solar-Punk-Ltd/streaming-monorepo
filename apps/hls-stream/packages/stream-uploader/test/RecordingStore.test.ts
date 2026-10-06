import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { RecordingStore } from '../src/libs/RecordingStore.js';

const TOPIC = 'declared-topic-0001';
const OTHER_TOPIC = 'declared-topic-0002';
const FIRST = 'a1'.repeat(32);
const SECOND = 'b2'.repeat(32);

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-store-'));
  tempRoots.push(root);
  return path.join(root, 'recordings', 'by-topic.json');
}

/** Runs `run` with the error log captured rather than printed, so expected failures stay out of the output. */
function capturingErrors<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const { error } = console;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    return { result: run(), lines };
  } finally {
    console.error = error;
  }
}

describe('RecordingStore', () => {
  it('knows no recording for a topic nothing has finished on', () => {
    assert.equal(new RecordingStore().recordingOf(TOPIC), null);
  });

  it('keeps one recording per topic, the newest', () => {
    const store = new RecordingStore();

    store.remember(TOPIC, FIRST);
    store.remember(OTHER_TOPIC, FIRST);
    store.remember(TOPIC, SECOND);

    assert.equal(store.recordingOf(TOPIC), SECOND);
    assert.equal(store.recordingOf(OTHER_TOPIC), FIRST);
  });

  it('answers what an earlier process remembered, from its file', () => {
    const filePath = storePath();
    new RecordingStore(filePath).remember(TOPIC, FIRST);

    const restarted = new RecordingStore(filePath);

    assert.equal(restarted.recordingOf(TOPIC), FIRST);
    assert.equal(restarted.getMsSinceSaveFailed(), null);
  });

  it('reads a damaged file as empty and says so, rather than throwing into a broadcast', () => {
    const filePath = storePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json');

    const { result, lines } = capturingErrors(() => new RecordingStore(filePath).recordingOf(TOPIC));

    assert.equal(result, null);
    assert.equal(lines.length, 1);
  });

  it('ignores an entry that is not a reference', () => {
    const filePath = storePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ [TOPIC]: 'not-a-reference', [OTHER_TOPIC]: FIRST }));

    const store = new RecordingStore(filePath);

    assert.equal(store.recordingOf(TOPIC), null);
    assert.equal(store.recordingOf(OTHER_TOPIC), FIRST);
  });

  it('still answers from memory when the file cannot be written, and says how long it has failed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-store-'));
    tempRoots.push(root);
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const store = new RecordingStore(path.join(blocker, 'recordings', 'by-topic.json'));

    const { lines } = capturingErrors(() => store.remember(TOPIC, FIRST));

    assert.equal(store.recordingOf(TOPIC), FIRST);
    assert.notEqual(store.getMsSinceSaveFailed(), null);
    assert.equal(lines.length, 1);
  });
});
