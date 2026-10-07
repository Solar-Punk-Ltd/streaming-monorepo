/**
 * What a deployment page says runs, from what each container was seen to
 * be started from. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runningCommitOf, runningLabelOf } from './runningCommit.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('runningCommitOf', () => {
  it('is one commit when every container agrees', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: A },
        { service: 'stream-uploader', buildCommit: A },
      ]),
      { kind: 'one', commit: A },
    );
  });

  it('is mixed, naming each service, when they do not', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: B },
        { service: 'stream-uploader', buildCommit: A },
      ]),
      {
        kind: 'mixed',
        byService: [
          { service: 'srs', commit: B },
          { service: 'stream-uploader', commit: A },
        ],
      },
    );
  });

  it('is unknown when nothing was observed, or a container carries no commit', () => {
    assert.deepEqual(runningCommitOf([]), { kind: 'unknown' });
    assert.deepEqual(runningCommitOf([{ service: 'srs', buildCommit: null }]), { kind: 'unknown' });
  });

  it('counts a container without a commit as unknown beside known ones, not as agreement', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: A },
        { service: 'bee-uploader', buildCommit: null },
      ]),
      {
        kind: 'mixed',
        byService: [
          { service: 'srs', commit: A },
          { service: 'bee-uploader', commit: null },
        ],
      },
    );
  });
});

describe('runningLabelOf', () => {
  it('is the label and the commit when every container agrees on both', () => {
    assert.deepEqual(
      runningLabelOf([
        { service: 'client', buildCommit: A, buildLabel: 'QA-build-2026-10-07' },
        { service: 'bee-gateway', buildCommit: A, buildLabel: 'QA-build-2026-10-07' },
      ]),
      { label: 'QA-build-2026-10-07', commit: A },
    );
  });

  it('is nothing when nothing was observed, or the build carries no label', () => {
    assert.equal(runningLabelOf([]), null);
    assert.equal(runningLabelOf([{ service: 'srs', buildCommit: A, buildLabel: null }]), null);
    assert.equal(runningLabelOf([{ service: 'srs', buildCommit: A }]), null, 'an answer without the field');
    assert.equal(runningLabelOf([{ service: 'srs', buildCommit: null, buildLabel: 'v1' }]), null);
  });

  it('is nothing when the containers run two commits, or two builds of one commit under two labels', () => {
    assert.equal(
      runningLabelOf([
        { service: 'srs', buildCommit: A, buildLabel: 'v1' },
        { service: 'stream-uploader', buildCommit: B, buildLabel: 'v1' },
      ]),
      null,
    );
    assert.equal(
      runningLabelOf([
        { service: 'srs', buildCommit: A, buildLabel: 'v1' },
        { service: 'stream-uploader', buildCommit: A, buildLabel: 'v2' },
      ]),
      null,
    );
    assert.equal(
      runningLabelOf([
        { service: 'srs', buildCommit: A, buildLabel: 'v1' },
        { service: 'stream-uploader', buildCommit: A, buildLabel: null },
      ]),
      null,
      'a container whose build carries none is not agreement',
    );
  });
});
