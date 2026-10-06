/**
 * A feed topic the stack's deploy script would refuse.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The manager hands the topic to that script as `--feed-topic=<value>`, and
 * _lib.sh's require_override_shape refuses the flag outside
 * /^[A-Za-z0-9._-]{1,64}$/. A value the schema takes and the flag does not is
 * stored here and then fails on the deployment host, as a red deployment
 * nobody can run, rather than as an answer to the request that created it.
 *
 * Three places state that one shape now: the script, `FEED_TOPIC_RE` in
 * common, which every request schema and the UI's form check both read, and a
 * CHECK on the column. The CHECK is read out of its migration below and
 * compared with common's, because a rule written twice is a rule that drifts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEED_TOPIC_RE } from '@streaming-infra-manager/common';

import {
  createGroupSchema,
  createProfileSchema,
  updateGroupConfigSchema,
  updateProfileSchema,
} from '../../src/schemas/profile.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '..', '..', 'src', 'migrations', '033_profile_feed_topic_shape.sql');

/** The shape the column refuses on, read out of the migration's own CHECK. */
function columnShape(sql: string): string {
  const found = sql.match(/feed_topic ~ '([^']+)'/);
  assert.ok(found, 'the migration declares no CHECK over feed_topic');
  return found[1]!;
}

const BASE = { name: 'stage', kind: 'custom', components: ['srs'] };

/** The shape in the words the deploy script itself uses for it. */
const SHAPE_MESSAGE = /letters, digits, dot, underscore or hyphen, at most 64 characters/;

const REFUSED = [
  ['a space', 'my stream'],
  ['a slash', 'stream/1'],
  ['a dollar sign', '$(whoami)'],
  ['65 characters', 'a'.repeat(65)],
] as const;

const ACCEPTED = [
  ['a plain word', 'swarm-stream'],
  ['dot, underscore and hyphen together', 'a.b_c-1'],
  ['exactly 64 characters', 'a'.repeat(64)],
] as const;

describe('the feed topic a create body may carry', () => {
  for (const [label, topic] of REFUSED) {
    it(`refuses ${label}, as the deploy script does`, async () => {
      await assert.rejects(() => createProfileSchema.validate({ ...BASE, feed_topic: topic }), SHAPE_MESSAGE);
    });
  }

  for (const [label, topic] of ACCEPTED) {
    it(`keeps ${label}`, async () => {
      const parsed = await createProfileSchema.validate({ ...BASE, feed_topic: topic });
      assert.equal(parsed.feed_topic, topic);
    });
  }
});

/**
 * Every body that carries a topic, each with the least else it needs. Four
 * schemas, so the rule is asked of each: one left on a looser copy would store
 * what the other three refuse.
 */
const BODIES = [
  ['a deployment create', createProfileSchema, BASE],
  ['a deployment edit', updateProfileSchema, {}],
  ['a group create', createGroupSchema, { group_name: 'watchers', size: 2, kind: 'custom', components: ['srs'] }],
  ['a group edit', updateGroupConfigSchema, {}],
] as const;

describe('the feed topic every body that carries one may hold', () => {
  for (const [label, schema, body] of BODIES) {
    it(`is refused outside the stack's shape on ${label}`, async () => {
      for (const [, topic] of REFUSED) {
        await assert.rejects(() => schema.validate({ ...body, feed_topic: topic }), SHAPE_MESSAGE, topic);
      }
    });

    /**
     * Empty is not a topic, and the shape's lower bound says so. A form that
     * clears the field sends null, which is what puts a deployment back on its
     * version's own topic.
     */
    it(`is refused when empty on ${label}`, async () => {
      await assert.rejects(() => schema.validate({ ...body, feed_topic: '' }), SHAPE_MESSAGE);
    });

    it(`may be null or absent on ${label}, which is the version's own topic`, async () => {
      const cleared = await schema.validate({ ...body, feed_topic: null });
      const absent = await schema.validate({ ...body });

      assert.equal(cleared.feed_topic, null);
      assert.equal(absent.feed_topic, undefined);
    });
  }
});

describe('the CHECK the column carries', () => {
  it('refuses exactly what the request refuses', () => {
    assert.equal(columnShape(readFileSync(MIGRATION, 'utf8')), FEED_TOPIC_RE.source);
  });

  it('leaves NULL alone, which is every deployment that names no topic', () => {
    assert.match(readFileSync(MIGRATION, 'utf8'), /feed_topic IS NULL/);
  });

  it('is declared NOT VALID, so a row stored before the rule cannot stop the upgrade', () => {
    // An existing row outside the shape is a deployment somebody is running.
    // NOT VALID holds new writes to the rule and leaves such a row where it is,
    // for an operator to find with the census query the migration names.
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /NOT VALID/);
    assert.match(sql, /SELECT name, feed_topic FROM profiles/);
  });
});
