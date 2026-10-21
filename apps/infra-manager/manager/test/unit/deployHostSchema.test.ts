/**
 * The host a new deployment may be created on.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * Every body that names a host for something new refuses `@`, and the UI's
 * form check reads the same rule from common.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEPLOY_HOST_RE } from '@streaming-infra-manager/common';

import { createGroupSchema, createProfileSchema, newDeploymentShapeQuerySchema } from '../../src/schemas/profile.js';

const BODIES = [
  ['a deployment create', createProfileSchema, { name: 'stage', kind: 'custom', components: ['srs'] }],
  ['a group create', createGroupSchema, { group_name: 'watchers', size: 2, kind: 'custom', components: ['srs'] }],
  ['the settings list asked for before a create', newDeploymentShapeQuerySchema, { kind: 'custom' }],
] as const;

const REFUSED_MESSAGE = /never user@host/;

describe('the host a new deployment may be created on', () => {
  for (const [label, schema, body] of BODIES) {
    it(`refuses user@host on ${label}, which the chequebook route cannot reach`, async () => {
      await assert.rejects(() => schema.validate({ ...body, host: 'deploy@203.0.113.4' }), REFUSED_MESSAGE);
    });

    it(`keeps localhost and an ssh alias on ${label}`, async () => {
      for (const host of ['localhost', 'bee2', 'node-1.example.com']) {
        const parsed = await schema.validate({ ...body, host });
        assert.equal(parsed.host, host);
      }
    });
  }

  it('is the one rule the UI checks the field against', () => {
    assert.equal(DEPLOY_HOST_RE.test('bee2'), true);
    assert.equal(DEPLOY_HOST_RE.test('deploy@203.0.113.4'), false);
  });
});
