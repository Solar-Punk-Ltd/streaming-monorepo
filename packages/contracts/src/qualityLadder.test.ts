import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_QUALITY_LADDER, qualityLadderSpec } from './qualityLadder.js';

describe('the default quality ladder', () => {
  it('is four rungs, lowest first', () => {
    assert.deepEqual(DEFAULT_QUALITY_LADDER, [
      { name: '360p', width: 640, height: 360, kbps: 700 },
      { name: '480p', width: 854, height: 480, kbps: 1200 },
      { name: '720p', width: 1280, height: 720, kbps: 2800 },
      { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
    ]);
  });

  it('is written as the uploader reads it, highest first', () => {
    assert.equal(
      qualityLadderSpec(DEFAULT_QUALITY_LADDER),
      '1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700',
    );
  });

  it('writes a ladder given highest first in the same order', () => {
    assert.equal(qualityLadderSpec([...DEFAULT_QUALITY_LADDER].reverse()), qualityLadderSpec(DEFAULT_QUALITY_LADDER));
  });
});
