/**
 * OBS connection details. Unit test — a row and its stage in, strings out.
 *
 * The URL shapes themselves are pinned in web2-admin-common's own test; what
 * is pinned here is the assembly: which part of the row becomes the app, which
 * becomes the stream name, that the address, the ports and the SRT passphrase
 * are the stage's, as the manager pushed them, rather than invented per stream,
 * that RTMP is sent only where the stage's record offers it, and that a stream with no
 * stage gets its own id and key and nowhere to send them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageRecord } from '@streaming-monorepo/contracts';

import { IngestService, ingestDetailsFor } from '../../src/domain/IngestService.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import type { StageSecretsRow } from '../../src/types/index.js';

import { FakeStreamStore, InMemoryAuditLog, streamRow } from './support/fakes.js';
import { FakeStageStore, SRT_PASSPHRASE, STAGE_ID, stageRecord } from './support/stageFakes.js';

/** The stage as the ingest details read it, passphrase included. */
async function stageWith(ingest: Partial<StageRecord['ingest']> = {}, over: Partial<StageRecord> = {}) {
  const stages = new FakeStageStore();
  const record = stageRecord(over);
  await stages.upsert(splitStageRecord({ ...record, ingest: { ...record.ingest, rtmpPublic: true, ...ingest } }));
  return { stages, stage: (await stages.find(record.stageId)) as StageSecretsRow };
}

describe('ingestDetailsFor', () => {
  it('builds every field from the row and its stage', async () => {
    const { stage } = await stageWith();
    const row = streamRow({
      media_type: 'video',
      publish_key: '0123456789abcdef0123456789abcdef',
      publish_key_rotated_at: new Date('2026-09-11T12:00:00.000Z'),
    });

    assert.deepEqual(ingestDetailsFor(row, stage), {
      streamId: `video/${row.topic}`,
      app: 'video',
      stream: row.topic,
      publishKey: '0123456789abcdef0123456789abcdef',
      publishKeyRotatedAt: '2026-09-11T12:00:00.000Z',
      stage: { stageId: STAGE_ID, name: 'Main stage', retiredAt: null },
      srt: {
        url: `srt://ingest.example.org:10061?streamid=#!::r=video/${row.topic}?key=0123456789abcdef0123456789abcdef,m=publish`,
        passphrase: SRT_PASSPHRASE,
      },
      rtmp: {
        server: 'rtmp://ingest.example.org:10062/video',
        streamKey: `${row.topic}?key=0123456789abcdef0123456789abcdef`,
      },
    });
  });

  it('uses the media type as the SRS app, so audio lands on the audio path', async () => {
    const { stage } = await stageWith();
    const row = streamRow({ media_type: 'audio' });
    const details = ingestDetailsFor(row, stage);

    assert.equal(details.app, 'audio');
    assert.equal(details.streamId, `audio/${row.topic}`);
    assert.equal(details.rtmp?.server, 'rtmp://ingest.example.org:10062/audio');
    assert.match(details.srt!.url, new RegExp(`r=audio/${row.topic}`));
  });

  it('offers RTMP on an SRS stage, whose record the manager marks as taking RTMP', async () => {
    const { stage } = await stageWith({ rtmpPublic: true }, { engine: 'srs' });
    const details = ingestDetailsFor(streamRow(), stage);

    assert.equal(details.rtmp?.server, 'rtmp://ingest.example.org:10062/video');
    assert.ok(details.srt!.url.startsWith('srt://ingest.example.org:10061?'));
  });

  it('sends no RTMP server or stream key on an OvenMediaEngine stage, which takes SRT alone', async () => {
    const { stage } = await stageWith({ rtmpPublic: false }, { engine: 'ome' });
    const details = ingestDetailsFor(streamRow(), stage);

    assert.equal(details.rtmp, null);
    assert.ok(details.srt!.url.startsWith('srt://ingest.example.org:10061?'));
  });

  it('reports no passphrase when the stage has SRT unencrypted', async () => {
    const { stage } = await stageWith({ srtPassphrase: null });
    assert.equal(ingestDetailsFor(streamRow(), stage).srt!.passphrase, null);
  });

  it('has no rotation timestamp until the key is rotated', async () => {
    const { stage } = await stageWith();
    assert.equal(ingestDetailsFor(streamRow(), stage).publishKeyRotatedAt, null);
  });

  it('follows the address and ports the manager pushed for the stage', async () => {
    const { stage } = await stageWith({ host: 'stage-b.example.org', srtPort: 10001, rtmpPort: 10002 });
    const details = ingestDetailsFor(streamRow(), stage);

    assert.match(details.srt!.url, /^srt:\/\/stage-b\.example\.org:10001\?/);
    assert.equal(details.rtmp?.server, 'rtmp://stage-b.example.org:10002/video');
  });

  it('keeps the details of a stage the manager retired, and says it was retired', async () => {
    const { stages } = await stageWith();
    await stages.retire(STAGE_ID, '2026-09-28T11:00:00.000Z');
    const details = ingestDetailsFor(streamRow(), (await stages.find(STAGE_ID))!);

    assert.equal(details.stage?.retiredAt, '2026-09-28T11:00:00.000Z');
    assert.ok(details.srt!.url.startsWith('srt://ingest.example.org:10061?'));
  });

  it('answers only the stream id and key of a stream with no stage', () => {
    const row = streamRow({ stage_id: null });
    const details = ingestDetailsFor(row, null);

    assert.deepEqual(details, {
      streamId: `video/${row.topic}`,
      app: 'video',
      stream: row.topic,
      publishKey: row.publish_key,
      publishKeyRotatedAt: null,
      stage: null,
      srt: null,
      rtmp: null,
    });
  });
});

describe('IngestService', () => {
  it('reads the stage of the stream for its details and after a rotation', async () => {
    const { stages } = await stageWith();
    const store = new FakeStreamStore();
    const service = new IngestService(store, stages, new InMemoryAuditLog());
    const row = store.add(streamRow());

    const details = await service.detailsFor(row.id);
    const rotated = await service.rotateKey({ kind: 'system', reason: 'test' }, row.id);

    assert.equal(details.stage?.stageId, STAGE_ID);
    assert.equal(details.srt?.passphrase, SRT_PASSPHRASE);
    assert.equal(rotated.stage?.stageId, STAGE_ID);
    assert.ok(rotated.srt?.url.includes(`key=${rotated.publishKey}`), 'the new key is on the SRT line');
  });

  it('answers a stream with no stage without looking one up', async () => {
    const stages = new FakeStageStore();
    stages.find = () => Promise.reject(new Error('no lookup expected'));
    const store = new FakeStreamStore();
    const row = store.add(streamRow({ stage_id: null }));

    const details = await new IngestService(store, stages, new InMemoryAuditLog()).detailsFor(row.id);

    assert.equal(details.stage, null);
    assert.equal(details.srt, null);
  });
});
