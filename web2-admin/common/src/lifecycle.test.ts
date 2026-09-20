import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  InternalCompletedRecordingSnapshot,
  ManagedRunReport,
} from './lifecycle.js';
import { canonicalManagedReportJson } from './lifecycle.js';

interface DigestFixture {
  report: ManagedRunReport;
  canonicalUtf8: string;
  sha256HexParts: [string, string];
}

interface VodReconciliationFixture {
  report: Extract<ManagedRunReport, { state: 'vod' }>;
  reconciledCompletedRecording: InternalCompletedRecordingSnapshot;
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

test('managed VOD digest retains report array order across reconciliation', () => {
  const vodFixture = JSON.parse(
    readFileSync(
      new URL(
        '../fixtures/managed-vod-reconciliation-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as VodReconciliationFixture;

  assert.deepEqual(vodFixture.report.completedRecording.expectedRenditions, [
    '360p',
    '720p',
    '1080p',
  ]);
  assert.deepEqual(vodFixture.reconciledCompletedRecording.expectedRenditions, [
    '1080p',
    '360p',
    '720p',
  ]);
  assert.equal(
    createHash('sha256')
      .update(canonicalManagedReportJson(vodFixture.report))
      .digest('hex'),
    vodFixture.sha256HexParts.join(''),
  );
});
