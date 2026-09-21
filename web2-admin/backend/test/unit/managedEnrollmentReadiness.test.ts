/**
 * Managed enrollment readiness, against a scripted Postgres client. Unit test,
 * no database. `pnpm test`.
 *
 * A stream enters the managed lifecycle when the configured uploader holds a
 * fresh capability record offering the stream's media type, and on nothing
 * else. The service, the readiness check and the capability repository run for
 * real here. Only the client is scripted: a fresh record is a capability row
 * the query returns, and a missing or stale one is a query that returns
 * nothing. The freshness window itself is SQL, so the integration suite is
 * what proves a record older than it is refused.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UploaderMediaProfile } from '@streaming-monorepo/web2-admin-common';
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { ManagedEnrollmentUnavailableError } from '../../src/domain/errors/index.js';
import { LegacyAdoptionRepository } from '../../src/domain/LegacyAdoptionRepository.js';
import { ManagedEnrollmentReadiness } from '../../src/domain/ManagedEnrollmentReadiness.js';
import { ManagedEnrollmentService } from '../../src/domain/ManagedEnrollmentService.js';
import { UploaderCapabilityRepository } from '../../src/domain/UploaderCapabilityRepository.js';

const UPLOADER_ID = 'srs-uploader-a';
const STREAM_ID = 'stream-1';
const OWNER_ID = 'owner-1';

const videoProfile: UploaderMediaProfile = {
  mediaType: 'video',
  renditions: [
    {
      name: '720p',
      width: 1280,
      height: 720,
      bandwidth: 2_800_000,
      avgBandwidth: 2_500_000,
    },
  ],
};

const idleVideoPlaceholder = {
  id: STREAM_ID,
  topic: 'enrollment-topic',
  media_type: 'video',
  status: 'draft',
  lifecycle_version: null,
  manifest_index: null,
  duration_seconds: null,
  live_since: null,
  ended_at: null,
  has_renditions: false,
};

interface Statement {
  sql: string;
  params: unknown[];
}

interface ScriptedDatabase {
  pool: Pool;
  statements: Statement[];
}

/** Answers the stream lock with an idle video placeholder and the capability read with `freshProfiles`, or with nothing when it is null. */
function scriptedDatabase(
  freshProfiles: UploaderMediaProfile[] | null,
): ScriptedDatabase {
  const statements: Statement[] = [];
  const answer = (sql: string): unknown[] => {
    if (sql.includes('FOR UPDATE')) return [idleVideoPlaceholder];
    if (sql.includes('FROM uploader_capability_receipts') && freshProfiles) {
      return [
        {
          uploader_id: UPLOADER_ID,
          lifecycle_version: 1,
          profiles: freshProfiles,
          received_at: new Date(),
        },
      ];
    }
    return [];
  };
  const client = {
    query: (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return Promise.resolve({ rows: answer(sql) });
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    connect: () => Promise.resolve(client),
    query: client.query.bind(client),
  } as unknown as Pool;
  return { pool, statements };
}

function readinessFor(pool: Pool): ManagedEnrollmentReadiness {
  return new ManagedEnrollmentReadiness(
    new UploaderCapabilityRepository(pool, UPLOADER_ID),
  );
}

function wrote(statements: Statement[], fragment: string): boolean {
  return statements.some(({ sql }) => sql.includes(fragment));
}

function isRefusalFor(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ManagedEnrollmentUnavailableError);
    assert.equal(error.reason, reason);
    return true;
  };
}

describe('managed enrollment readiness', () => {
  it('enrolls from a fresh capability record alone, with no release receipts', async () => {
    const database = scriptedDatabase([videoProfile]);
    const enrollment = new ManagedEnrollmentService(
      database.pool,
      readinessFor(database.pool),
      UPLOADER_ID,
    );

    assert.equal(
      await enrollment.enrollEligiblePlaceholder(STREAM_ID, OWNER_ID),
      'enrolled',
    );

    const run = database.statements.find(({ sql }) =>
      sql.includes('INSERT INTO stream_runs'),
    );
    assert.deepEqual(run?.params, [STREAM_ID, UPLOADER_ID]);
    const enrolled = database.statements.find(({ sql }) =>
      sql.includes('SET lifecycle_version = 1'),
    );
    assert.match(String(enrolled?.params[1]), /^[0-9a-f]{64}$/);
    assert.equal(database.statements.at(-1)?.sql, 'COMMIT');
  });

  it('refuses without a fresh capability record, says so, and writes nothing', async () => {
    const database = scriptedDatabase(null);
    const enrollment = new ManagedEnrollmentService(
      database.pool,
      readinessFor(database.pool),
      UPLOADER_ID,
    );

    await assert.rejects(
      enrollment.enrollEligiblePlaceholder(STREAM_ID, OWNER_ID),
      isRefusalFor('uploader_capability_not_fresh'),
    );
    await assert.rejects(
      enrollment.enrollEligiblePlaceholder(STREAM_ID, OWNER_ID),
      /fresh capability record/,
    );
    assert.equal(wrote(database.statements, 'INSERT INTO'), false);
    assert.equal(wrote(database.statements, 'UPDATE streams'), false);
    assert.equal(database.statements.at(-1)?.sql, 'ROLLBACK');
  });

  it('refuses when the fresh record offers no profile for the stream media type', async () => {
    const database = scriptedDatabase([{ ...videoProfile, mediaType: 'audio' }]);
    const enrollment = new ManagedEnrollmentService(
      database.pool,
      readinessFor(database.pool),
      UPLOADER_ID,
    );

    await assert.rejects(
      enrollment.enrollEligiblePlaceholder(STREAM_ID, OWNER_ID),
      isRefusalFor('uploader_capability_not_fresh'),
    );
  });

  it('refuses a legacy adoption preview for the same reason', async () => {
    const database = scriptedDatabase(null);
    const adoptions = new LegacyAdoptionRepository(
      database.pool,
      readinessFor(database.pool),
      UPLOADER_ID,
    );

    await assert.rejects(
      adoptions.preview(STREAM_ID, OWNER_ID),
      isRefusalFor('uploader_capability_not_fresh'),
    );
  });

  it('answers 503 with the refusal reason in the body', () => {
    let status = 0;
    let body: unknown;
    const res = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    errorHandler(
      new ManagedEnrollmentUnavailableError(
        STREAM_ID,
        'uploader_capability_not_fresh',
      ),
      {} as Request,
      res,
      () => undefined,
    );

    assert.equal(status, 503);
    assert.deepEqual(body, {
      error: 'managed_enrollment_unavailable',
      id: STREAM_ID,
      reason: 'uploader_capability_not_fresh',
    });
  });
});
