import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  InternalCompletedRecordingSnapshot,
  LegacyRecordingCandidate,
  ManagedRenditionReport,
  ManagedRunReport,
  UploaderCapabilities,
} from './lifecycle.js';
import {
  canonicalManagedReportJson,
  canonicalManagedRenditionReportJson,
  canonicalLegacyRecordingCandidateJson,
  canonicalUploaderProfileJson,
} from './lifecycle.js';

interface DigestFixture {
  report: ManagedRunReport;
  canonicalUtf8: string;
  sha256HexParts: [string, string];
}

interface RenditionDigestFixture {
  report: ManagedRenditionReport;
  canonicalUtf8: string;
  sha256HexParts: [string, string];
}

interface VodReconciliationFixture {
  report: Extract<ManagedRunReport, { state: 'vod' }>;
  reconciledCompletedRecording: InternalCompletedRecordingSnapshot;
  sha256HexParts: [string, string];
}

interface CapabilityFixture {
  request: UploaderCapabilities;
  profileVectors: Array<{
    mediaType: 'audio' | 'video';
    canonicalUtf8: string;
    sha256HexParts: [string, string];
  }>;
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

test('managed rendition canonical bytes and SHA256 match the cross-service vector', () => {
  const renditionFixture = JSON.parse(
    readFileSync(
      new URL(
        '../fixtures/managed-rendition-digest-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RenditionDigestFixture;
  const canonical = canonicalManagedRenditionReportJson(
    renditionFixture.report,
  );
  assert.equal(canonical, renditionFixture.canonicalUtf8);
  assert.equal(
    createHash('sha256').update(canonical).digest('hex'),
    renditionFixture.sha256HexParts.join(''),
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

test('uploader profile fingerprints match the cross-service vectors', () => {
  const capabilityFixture = JSON.parse(
    readFileSync(
      new URL('../fixtures/uploader-capabilities-v1.json', import.meta.url),
      'utf8',
    ),
  ) as CapabilityFixture;

  for (const vector of capabilityFixture.profileVectors) {
    const profile = capabilityFixture.request.profiles.find(
      (candidate) => candidate.mediaType === vector.mediaType,
    );
    assert.ok(profile);
    const canonical = canonicalUploaderProfileJson(profile);
    assert.equal(canonical, vector.canonicalUtf8);
    assert.equal(
      createHash('sha256').update(canonical).digest('hex'),
      vector.sha256HexParts.join(''),
    );
  }
});

test('legacy adoption candidate digest normalizes rendition order', () => {
  const adoptionFixture = JSON.parse(
    readFileSync(
      new URL('../fixtures/legacy-adoption-v1.json', import.meta.url),
      'utf8',
    ),
  ) as {
    candidate: LegacyRecordingCandidate;
    canonicalUtf8: string;
    sha256HexParts: [string, string];
  };
  const reversed = {
    ...adoptionFixture.candidate,
    renditions: [...adoptionFixture.candidate.renditions].reverse(),
  };
  const canonical = canonicalLegacyRecordingCandidateJson(reversed);
  assert.equal(canonical, adoptionFixture.canonicalUtf8);
  assert.equal(
    createHash('sha256').update(canonical).digest('hex'),
    adoptionFixture.sha256HexParts.join(''),
  );
});
