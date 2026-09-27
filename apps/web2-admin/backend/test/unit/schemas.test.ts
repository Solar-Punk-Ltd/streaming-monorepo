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

import { PASSWORD_MAX_LENGTH } from '@streaming-monorepo/web2-admin-common';

import { changePasswordSchema, createUserSchema, loginSchema } from '../../src/schemas/auth.js';
import { ingestLookupParamSchema, renditionReportSchema, streamStateSchema } from '../../src/schemas/internal.js';
import { streamIdParamSchema, streamInputSchema } from '../../src/schemas/stream.js';

const validate = <T>(
  schema: {
    validate: (value: unknown, options: object) => Promise<T>;
  },
  value: unknown,
): Promise<T> => schema.validate(value, { abortEarly: false, stripUnknown: true });

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
  title: 'Pilot keynote',
  description: 'The opening talk.',
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

describe('streamInputSchema', () => {
  it('accepts a complete body and trims it', async () => {
    const value = await validate(streamInputSchema, {
      ...goodStream,
      title: '  Pilot keynote  ',
      description: '  The opening talk.  ',
      tags: [' swarm ', 'swarm', 'pilot'],
    });
    assert.deepEqual(value, {
      title: 'Pilot keynote',
      description: 'The opening talk.',
      tags: ['swarm', 'pilot'],
      mediaType: 'video',
      scheduledStartTime: '2026-10-01T09:00:00.000Z',
    });
  });

  it('defaults tags to []', async () => {
    const value = await validate(streamInputSchema, {
      ...goodStream,
      title: 'Audio only',
      description: 'A podcast.',
      mediaType: 'audio',
    });
    assert.deepEqual(value.tags, []);
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
      scheduledStartTime: '2026-10-01T09:00:00.000Z',
    });
    assert.ok(
      errors.some((e) => e.includes('title')),
      errors.join('; '),
    );
    assert.ok(
      errors.some((e) => e.includes('description')),
      errors.join('; '),
    );
  });

  it('rejects a blank title', async () => {
    const errors = await errorsFor(streamInputSchema, {
      ...goodStream,
      title: '   ',
    });
    assert.ok(
      errors.some((e) => e.includes('title')),
      errors.join('; '),
    );
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

  it('requires a scheduled start time: missing, null and empty all fail', async () => {
    // A stream with no schedule cannot be edited through the console at all,
    // because the form will not submit without one; the API refuses to create
    // that row in the first place.
    const { scheduledStartTime: _omitted, ...withoutSchedule } = goodStream;
    for (const body of [
      withoutSchedule,
      { ...goodStream, scheduledStartTime: null },
      { ...goodStream, scheduledStartTime: '' },
    ]) {
      const errors = await errorsFor(streamInputSchema, body);
      assert.ok(
        errors.some((e) => e.includes('scheduledStartTime is required')),
        `${JSON.stringify(body)}: ${errors.join('; ')}`,
      );
    }
  });

  it('accepts a valid ISO 8601 scheduled start time', async () => {
    const value = await validate(streamInputSchema, {
      ...goodStream,
      scheduledStartTime: '2027-03-29T02:30:00.000Z',
    });
    assert.equal(value.scheduledStartTime, '2027-03-29T02:30:00.000Z');
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
  it('accepts a login body as it arrived, without reshaping it', async () => {
    // Neither field is trimmed or shape-checked: a wrong pair must answer the
    // same way whatever it looked like, and the rules that decide whether a
    // password is good enough belong to the routes that set one.
    const value = await validate(loginSchema, {
      username: 'admin',
      password: 'admin1234',
    });
    assert.deepEqual(value, { username: 'admin', password: 'admin1234' });
  });

  it('requires both login fields', async () => {
    const errors = await errorsFor(loginSchema, {});
    assert.equal(errors.length, 2);
  });

  it('bounds the login body so no caller can make scrypt hash 256 KB', async () => {
    const errors = await errorsFor(loginSchema, {
      username: 'admin',
      password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
    });
    assert.equal(errors.length, 1);
  });

  it('requires both password-change fields, and leaves the policy to common', async () => {
    const errors = await errorsFor(changePasswordSchema, {});
    assert.equal(errors.length, 2);

    // `short` passes the schema: `passwordProblem` is what refuses it, with a
    // sentence the operator can act on. The route test pins the 400.
    const ok = await validate(changePasswordSchema, {
      currentPassword: 'admin1234',
      newPassword: 'short',
    });
    assert.equal(ok.newPassword, 'short');
  });

  it('accepts a create-user body, admin flag and all', async () => {
    const value = await validate(createUserSchema, {
      username: 'mate',
      password: 'a-perfectly-good-password',
      admin: true,
    });
    assert.deepEqual(value, {
      username: 'mate',
      password: 'a-perfectly-good-password',
      admin: true,
    });
  });

  it('refuses a username the database CHECK would refuse', async () => {
    for (const username of ['Mate', 'x', '_leading', 'has space', 'a'.repeat(33)]) {
      const errors = await errorsFor(createUserSchema, {
        username,
        password: 'a-perfectly-good-password',
      });
      assert.equal(errors.length, 1, username);
      assert.match(errors[0]!, /username must be 2 to 32 characters/);
    }
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
    assert.deepEqual(await errorsFor(streamStateSchema, { state: 'live', index: 4 }), [
      'index is only sent with state vod',
    ]);
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
    assert.deepEqual(await errorsFor(streamStateSchema, { state: 'published' }), ['state must be one of live, vod']);
  });
});

describe('renditionReportSchema', () => {
  const goodRung = {
    name: '720p',
    width: 1280,
    height: 720,
    topic: 'bbbbbbbb-0000-4000-8000-000000000720',
    bandwidth: 2800000,
    avgBandwidth: 2400000,
  };

  it('accepts a rung that is still delivering', async () => {
    const value = await validate(renditionReportSchema, goodRung);
    assert.deepEqual(value, goodRung);
  });

  it('accepts a rung that has finalized', async () => {
    const value = await validate(renditionReportSchema, {
      ...goodRung,
      index: 42,
      duration: 61.5,
    });
    assert.deepEqual(value, { ...goodRung, index: 42, duration: 61.5 });
  });

  it('refuses one of index and duration without the other', async () => {
    // A ladder is finished when every rung has an index, and an index with no
    // duration would finish it with nothing to put on the entry's seek bar.
    const message = 'index and duration are sent together, or neither is';
    assert.deepEqual(await errorsFor(renditionReportSchema, { ...goodRung, index: 42 }), [message]);
    assert.deepEqual(await errorsFor(renditionReportSchema, { ...goodRung, duration: 61.5 }), [message]);
  });

  it('accepts index 0 with duration 0, which is not "absent"', async () => {
    const value = await validate(renditionReportSchema, {
      ...goodRung,
      index: 0,
      duration: 0,
    });
    assert.equal(value.index, 0);
    assert.equal(value.duration, 0);
  });

  it('refuses a name outside the charset the uploader uses', async () => {
    // '_' separates the base from the rung in an ingest id, so it cannot be
    // part of a rung name; the rest would end up in a master playlist and in
    // log lines unescaped.
    for (const name of ['720_p', '720p/../etc', '', 'x'.repeat(33), 'rung p']) {
      const errors = await errorsFor(renditionReportSchema, {
        ...goodRung,
        name,
      });
      assert.ok(
        errors.some((e) => e.includes('name')),
        `accepted ${name}`,
      );
    }
  });

  it('refuses a rung topic that is not a UUID', async () => {
    assert.deepEqual(
      await errorsFor(renditionReportSchema, {
        ...goodRung,
        topic: "' OR 1=1 --",
      }),
      ['topic must be a UUID'],
    );
  });

  it('refuses geometry and bandwidths that cannot describe a rung', async () => {
    const errors = await errorsFor(renditionReportSchema, {
      ...goodRung,
      width: 0,
      height: -720,
      bandwidth: -1,
      avgBandwidth: 2400000.5,
    });
    assert.deepEqual(errors.sort(), [
      'avgBandwidth must be a whole number',
      'bandwidth must not be negative',
      'height must be positive',
      'width must be positive',
    ]);
  });

  it('requires every field a master playlist entry needs', async () => {
    const errors = await errorsFor(renditionReportSchema, {});
    assert.equal(errors.length, 6, errors.join('; '));
  });
});
