/**
 * Request validation. Unit test — the schemas only, no HTTP.
 *
 * These are the rules msrs-client enforced in the browser and nowhere else, so
 * what matters is both halves: that a good body is accepted *and normalised*
 * (trimmed, deduplicated, defaulted), and that a bad one is rejected with a
 * message the console can show.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationError } from 'yup';

import { changePasswordSchema, loginSchema } from '../../src/schemas/auth.js';
import {
  ingestLookupParamSchema,
  streamStateSchema,
} from '../../src/schemas/internal.js';
import {
  streamIdParamSchema,
  streamInputSchema,
} from '../../src/schemas/stream.js';

const validate = <T>(schema: {
  validate: (value: unknown, options: object) => Promise<T>;
}, value: unknown): Promise<T> =>
  schema.validate(value, { abortEarly: false, stripUnknown: true });

async function errorsFor(schema: Parameters<typeof validate>[0], value: unknown) {
  try {
    await validate(schema, value);
    assert.fail('expected a ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError, `not a ValidationError: ${err}`);
    return err.errors;
  }
}

const goodStream = {
  title: 'Devcon keynote',
  description: 'The opening talk.',
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

describe('streamInputSchema', () => {
  it('accepts a complete body and trims it', async () => {
    const value = await validate(streamInputSchema, {
      ...goodStream,
      title: '  Devcon keynote  ',
      description: '  The opening talk.  ',
      tags: [' swarm ', 'swarm', 'devcon'],
    });
    assert.deepEqual(value, {
      title: 'Devcon keynote',
      description: 'The opening talk.',
      tags: ['swarm', 'devcon'],
      mediaType: 'video',
      scheduledStartTime: '2026-10-01T09:00:00.000Z',
    });
  });

  it('defaults tags to [] and scheduledStartTime to null', async () => {
    const value = await validate(streamInputSchema, {
      title: 'Audio only',
      description: 'A podcast.',
      mediaType: 'audio',
    });
    assert.deepEqual(value.tags, []);
    assert.equal(value.scheduledStartTime, null);
  });

  it('strips unknown fields instead of storing them', async () => {
    const value = (await validate(streamInputSchema, {
      ...goodStream,
      status: 'published',
      owner: 'me',
    })) as Record<string, unknown>;
    assert.equal('status' in value, false);
    assert.equal('owner' in value, false);
  });

  it('requires a title and a description', async () => {
    const errors = await errorsFor(streamInputSchema, {
      mediaType: 'video',
      scheduledStartTime: null,
    });
    assert.ok(errors.some((e) => e.includes('title')), errors.join('; '));
    assert.ok(errors.some((e) => e.includes('description')), errors.join('; '));
  });

  it('rejects a blank title', async () => {
    const errors = await errorsFor(streamInputSchema, {
      ...goodStream,
      title: '   ',
    });
    assert.ok(errors.some((e) => e.includes('title')), errors.join('; '));
  });

  it('enforces the msrs-client limits: 100, 500, 10 tags, 20 chars each', async () => {
    const tooLongTitle = await errorsFor(streamInputSchema, {
      ...goodStream,
      title: 'x'.repeat(101),
    });
    assert.ok(tooLongTitle.some((e) => e.includes('at most 100')));

    const tooLongDescription = await errorsFor(streamInputSchema, {
      ...goodStream,
      description: 'x'.repeat(501),
    });
    assert.ok(tooLongDescription.some((e) => e.includes('at most 500')));

    const tooManyTags = await errorsFor(streamInputSchema, {
      ...goodStream,
      tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`),
    });
    assert.ok(tooManyTags.some((e) => e.includes('at most 10 tags')));

    const tooLongTag = await errorsFor(streamInputSchema, {
      ...goodStream,
      tags: ['x'.repeat(21)],
    });
    assert.ok(tooLongTag.some((e) => e.includes('at most 20 characters')));
  });

  it('counts tags after deduplication', async () => {
    const value = await validate(streamInputSchema, {
      ...goodStream,
      tags: Array.from({ length: 12 }, () => 'swarm'),
    });
    assert.deepEqual(value.tags, ['swarm']);
  });

  it('rejects a blank tag', async () => {
    const errors = await errorsFor(streamInputSchema, {
      ...goodStream,
      tags: ['  '],
    });
    assert.ok(errors.length > 0);
  });

  it('rejects an unknown media type', async () => {
    const errors = await errorsFor(streamInputSchema, {
      ...goodStream,
      mediaType: 'hologram',
    });
    assert.ok(
      errors.some((e) => e.includes('mediaType must be one of')),
      errors.join('; '),
    );
  });

  it('rejects a scheduled start time that is not a date', async () => {
    const errors = await errorsFor(streamInputSchema, {
      ...goodStream,
      scheduledStartTime: 'next tuesday',
    });
    assert.ok(
      errors.some((e) => e.includes('ISO 8601')),
      errors.join('; '),
    );
  });
});

describe('streamIdParamSchema', () => {
  it('accepts a UUID', async () => {
    const value = await validate(streamIdParamSchema, {
      id: '1867808f-7b1c-4e46-b437-f7423b466b39',
    });
    assert.deepEqual(value, { id: '1867808f-7b1c-4e46-b437-f7423b466b39' });
  });

  it('rejects anything else', async () => {
    for (const id of ['', 'abc', '1867808f7b1c4e46b437f7423b466b39', '../../etc']) {
      const errors = await errorsFor(streamIdParamSchema, { id });
      assert.ok(errors.length > 0, `accepted ${id}`);
    }
  });
});

describe('auth schemas', () => {
  it('accepts a login body and trims the username', async () => {
    const value = await validate(loginSchema, {
      username: ' admin ',
      password: 'admin1234',
    });
    assert.deepEqual(value, { username: 'admin', password: 'admin1234' });
  });

  it('requires both login fields', async () => {
    const errors = await errorsFor(loginSchema, {});
    assert.equal(errors.length, 2);
  });

  it('requires a new password of at least 8 characters', async () => {
    const errors = await errorsFor(changePasswordSchema, {
      currentPassword: 'admin1234',
      newPassword: 'short',
    });
    assert.deepEqual(errors, ['newPassword must be at least 8 characters']);

    const ok = await validate(changePasswordSchema, {
      currentPassword: 'admin1234',
      newPassword: 'longenough',
    });
    assert.equal(ok.newPassword, 'longenough');
  });
});

describe('ingestLookupParamSchema', () => {
  it('accepts the two halves of an ingest stream id', async () => {
    const value = await validate(ingestLookupParamSchema, {
      app: 'audio',
      stream: '1867808f-7b1c-4e46-b437-f7423b466b39',
    });
    assert.deepEqual(value, {
      app: 'audio',
      stream: '1867808f-7b1c-4e46-b437-f7423b466b39',
    });
  });

  it('refuses anything the uploader could have been handed by an encoder', async () => {
    // `streamid=` is attacker-controlled all the way from OBS, so neither half
    // reaches a query unchecked.
    assert.deepEqual(
      await errorsFor(ingestLookupParamSchema, {
        app: 'video',
        stream: "' OR 1=1 --",
      }),
      ['stream must be a UUID'],
    );
    assert.deepEqual(
      await errorsFor(ingestLookupParamSchema, {
        app: 'text',
        stream: '1867808f-7b1c-4e46-b437-f7423b466b39',
      }),
      ['app must be one of video, audio'],
    );
  });
});

describe('streamStateSchema', () => {
  it('accepts a bare live report', async () => {
    const value = await validate(streamStateSchema, { state: 'live' });
    assert.deepEqual(value, { state: 'live' });
  });

  it('accepts a vod report with its index and duration', async () => {
    const value = await validate(streamStateSchema, {
      state: 'vod',
      index: 412,
      duration: 3725.5,
    });
    assert.deepEqual(value, { state: 'vod', index: 412, duration: 3725.5 });
  });

  it('requires both numbers with vod', async () => {
    assert.deepEqual(await errorsFor(streamStateSchema, { state: 'vod' }), [
      'index is required when state is vod',
      'duration is required when state is vod',
    ]);
  });

  it('refuses them with live, rather than dropping them quietly', async () => {
    // A live report carrying an index is the uploader sending the wrong
    // thing; swallowing it would put a stale index on the next entry written.
    assert.deepEqual(
      await errorsFor(streamStateSchema, { state: 'live', index: 4 }),
      ['index is only sent with state vod'],
    );
  });

  it('refuses a negative or fractional index and a negative duration', async () => {
    const errors = await errorsFor(streamStateSchema, {
      state: 'vod',
      index: -1.5,
      duration: -2,
    });
    assert.deepEqual(errors.sort(), [
      'duration must not be negative',
      'index must be a whole number',
      'index must not be negative',
    ]);
  });

  it('refuses a state this backend owns', async () => {
    // `published` and `draft` are the console's, not the uploader's.
    assert.deepEqual(
      await errorsFor(streamStateSchema, { state: 'published' }),
      ['state must be one of live, vod'],
    );
  });
});
