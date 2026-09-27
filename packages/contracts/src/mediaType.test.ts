import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MEDIA_TYPES, mediaTypeSchema } from './mediaType.js';

describe('the media type', () => {
  it('is video or audio, video first', () => {
    assert.deepEqual(MEDIA_TYPES, ['video', 'audio']);
    assert.equal(MEDIA_TYPE_VIDEO, 'video');
    assert.equal(MEDIA_TYPE_AUDIO, 'audio');
  });

  it('accepts each listed type', () => {
    for (const type of MEDIA_TYPES) {
      assert.equal(mediaTypeSchema.safeParse(type).success, true);
    }
  });

  it('refuses any other value, including a different case', () => {
    for (const value of ['Video', 'image', '', ' video', null, undefined, 1]) {
      assert.equal(mediaTypeSchema.safeParse(value).success, false, String(value));
    }
  });
});
