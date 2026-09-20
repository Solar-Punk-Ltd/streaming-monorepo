import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ManagedRunReport } from './lifecycle.js';
import { canonicalManagedReportJson } from './lifecycle.js';

interface DigestFixture {
  report: ManagedRunReport;
  canonicalUtf8: string;
  sha256HexParts: [string, string];
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/managed-report-digest-v1.json', import.meta.url),
    'utf8',
  ),
) as DigestFixture;

test('managed report canonical bytes and SHA256 match the cross-service vector', () => {
  const canonical = canonicalManagedReportJson(fixture.report);
  assert.equal(canonical, fixture.canonicalUtf8);
  assert.equal(
    createHash('sha256').update(canonical).digest('hex'),
    fixture.sha256HexParts.join(''),
  );
});
