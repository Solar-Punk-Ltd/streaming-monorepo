/**
 * SRS's periodic line for each RTMP publisher, read out of a log that carries
 * secrets beside it.
 *
 * Unit test, no Docker and no SRS. `pnpm test` in manager/.
 *
 * The fork's image 6.0-r2-swarm.3 ends the line with the vhost the publisher
 * is on, and older images end it at `pnt`. A broadcaster publishes onto the
 * ingest vhost and the ladder's rungs onto a vhost of their own, both over
 * RTMP. Around these lines sit the ones that carry what must never leave the
 * log: the connect line with the tcUrl, the identify line with the stream
 * key in `param`, the hook line with the uploader's token, and the line with
 * the publisher's address.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  parseRtmpPublishReport,
  parseRtmpPublishReports,
  RTMP_PUBLISH_HOST_PATTERN,
} from '../../src/domain/ingestHealth/rtmpPublishReport.js';
import { INGEST_LOG_LINES } from '../../src/domain/ingestHealth/IngestHealthService.js';

const INGEST =
  '[2026-10-03 17:43:50.386][INFO][1][9tq3vz71] <- CPB time=40021, okbps=0,0,0, ikbps=0,4812,0, mr=0/350, p1stpt=20000, pnt=5000, vhost=__defaultVhost__';
const RUNG =
  '[2026-10-03 17:43:51.002][INFO][1][r7u2ng48] <- CPB time=39010, okbps=0,0,0, ikbps=0,2795,0, mr=0/350, p1stpt=20000, pnt=5000, vhost=abr';
const OLDER_ENGINE =
  '[2026-09-30 10:00:00.000][INFO][1][o1dl1ne5] <- CPB time=40021, okbps=0,0,0, ikbps=0,4812,0, mr=0/350, p1stpt=20000, pnt=5000';

const ESC = '\u001b';

/** Lines of the same log around the reports, each carrying something a reading must never hold. */
const SECRET_BEARING = [
  '[2026-10-03 17:43:10.101][INFO][1][9tq3vz71] RTMP client ip=203.0.113.7:51514, fd=12',
  '[2026-10-03 17:43:10.120][INFO][1][9tq3vz71] connect app, tcUrl=rtmp://ingest.example.org:10062/video, pageUrl=, swfUrl=, schema=rtmp, vhost=ingest.example.org, port=10062, app=video, args=null',
  '[2026-10-03 17:43:10.130][INFO][1][9tq3vz71] client identified, type=fmle-publish, vhost=ingest.example.org, app=video, stream=1867808f, param=?key=abc123, duration=0ms',
  '[2026-10-03 17:43:10.140][INFO][1][9tq3vz71] http: on_publish ok, client_id=9tq3vz71, url=http://stream-uploader:3000/engines/srs/streams?token=abc123, response={"code":0}',
  '[2026-10-03 17:43:10.150][INFO][1][9tq3vz71] vhost change from ingest.example.org to __defaultVhost__',
];

describe('parseRtmpPublishReport', () => {
  it('reads the connection, the vhost and the 30-second incoming bitrate off a broadcaster on the ingest vhost', () => {
    assert.deepEqual(parseRtmpPublishReport(INGEST), {
      connection: '9tq3vz71',
      vhost: '__defaultVhost__',
      incomingKbps: 4812,
    });
  });

  it("reads a rung's line with the vhost the rungs are on", () => {
    assert.deepEqual(parseRtmpPublishReport(RUNG), { connection: 'r7u2ng48', vhost: 'abr', incomingKbps: 2795 });
  });

  it('reads the line an engine prints without the vhost, and says it names none', () => {
    assert.deepEqual(parseRtmpPublishReport(OLDER_ENGINE), {
      connection: 'o1dl1ne5',
      vhost: null,
      incomingKbps: 4812,
    });
  });

  it('takes the 30-second average, the second of the three incoming numbers, and no other', () => {
    const line = INGEST.replace('ikbps=0,4812,0', 'ikbps=7,4812,4790');
    assert.equal(parseRtmpPublishReport(line)?.incomingKbps, 4812);
  });

  it('reads the line through the colour codes SRS writes around it, a carriage return and the older level word', () => {
    for (const line of [
      `${ESC}[0m${INGEST}`,
      `${INGEST}${ESC}[0m`,
      `${ESC}[33m${INGEST}${ESC}[0m`,
      `${INGEST}\r`,
      INGEST.replace('[INFO]', '[Trace]'),
    ]) {
      assert.equal(parseRtmpPublishReport(line)?.vhost, '__defaultVhost__', JSON.stringify(line));
    }
  });

  it('refuses the play side, which reports what SRS sent a viewer', () => {
    assert.equal(
      parseRtmpPublishReport(
        '[2026-10-03 17:43:52.000][INFO][1][p1ay3r01] -> PLA time=30010, msgs=12, okbps=4790,4801,0, ikbps=0,0,0, mw=350/8',
      ),
      null,
    );
  });

  it('refuses an SRT report, which has its own reader', () => {
    assert.equal(
      parseRtmpPublishReport(
        '[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397',
      ),
      null,
    );
  });

  it('refuses every line around the reports that carries a key, a token or an address', () => {
    for (const line of SECRET_BEARING) assert.equal(parseRtmpPublishReport(line), null, line);
  });

  it('refuses the report text anywhere but at the start of a message, and anything after the vhost', () => {
    // A publisher chooses its own stream name and SRS quotes it into lines that carry a key or a token.
    assert.equal(
      parseRtmpPublishReport(
        `[2026-10-03 17:43:10.140][INFO][1][9tq3vz71] http: on_publish url=http://stream-uploader:3000/engines/srs/streams?token=abc123 ${INGEST.slice(INGEST.indexOf('<-'))}`,
      ),
      null,
    );
    assert.equal(parseRtmpPublishReport(`[2026-10-03 17:43:10.130][INFO][1][9tq3vz71] stream=${INGEST}`), null);
    assert.equal(parseRtmpPublishReport(`${INGEST}, token=abc123`), null);
    assert.equal(
      parseRtmpPublishReport(INGEST.replace('vhost=__defaultVhost__', 'vhost=__defaultVhost__?key=abc123')),
      null,
    );
    assert.equal(parseRtmpPublishReport(INGEST.replace('vhost=__defaultVhost__', 'vhost=')), null);
  });

  it('refuses a line cut before its last field, or a number too long or negative', () => {
    for (const line of [
      INGEST.slice(0, INGEST.indexOf('ikbps=') + 8),
      INGEST.slice(0, INGEST.indexOf(', pnt=')),
      INGEST.slice(INGEST.indexOf('<- CPB')),
      INGEST.replace('ikbps=0,4812,0', 'ikbps=0,12345678901234567,0'),
      INGEST.replace('ikbps=0,4812,0', 'ikbps=0,-4812,0'),
      INGEST.replace('mr=0/350', 'mr=0'),
    ]) {
      assert.equal(parseRtmpPublishReport(line), null, line);
    }
  });

  it('keeps the marker a reader filters on inside every line it reads', () => {
    for (const line of [INGEST, RUNG, OLDER_ENGINE]) assert.ok(line.includes(INGEST_LOG_LINES.marker));
  });
});

describe('parseRtmpPublishReports', () => {
  const LOG = [...SECRET_BEARING, INGEST, RUNG, OLDER_ENGINE];

  it('keeps the reports in the order they were written', () => {
    assert.deepEqual(
      parseRtmpPublishReports(LOG).map((report) => report.connection),
      ['9tq3vz71', 'r7u2ng48', 'o1dl1ne5'],
    );
  });

  it('hands on no text from the log but the connection a report came from and its vhost', () => {
    const reports = parseRtmpPublishReports(LOG);
    const text = JSON.stringify(reports);

    for (const secret of ['abc123', 'token', '203.0.113.7', 'stream-uploader', 'ingest.example.org', '1867808f']) {
      assert.ok(!text.includes(secret), `${secret} reached the parsed reports`);
    }
    for (const report of reports) {
      assert.deepEqual(Object.keys(report).sort(), ['connection', 'incomingKbps', 'vhost']);
      assert.ok(Number.isSafeInteger(report.incomingKbps));
    }
  });
});

describe('the RTMP pattern a remote reader filters with, run by grep', () => {
  /** Lines through the host's own `grep -E`, which is what runs on the remote host. */
  function keptByGrep(lines: readonly string[]): string[] {
    const run = spawnSync('grep', ['-E', '-e', RTMP_PUBLISH_HOST_PATTERN], {
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
    return run.stdout.split('\n').filter((line) => line !== '');
  }

  it('keeps exactly the lines the parser reads', () => {
    const lines = [
      INGEST,
      RUNG,
      OLDER_ENGINE,
      `${ESC}[0m${INGEST}`,
      `${ESC}[33m${INGEST}${ESC}[0m`,
      INGEST.replace('[INFO]', '[Trace]'),
      ...SECRET_BEARING,
      `${INGEST}, token=abc123`,
      INGEST.replace('vhost=__defaultVhost__', 'vhost=__defaultVhost__?key=abc123'),
      `[2026-10-03 17:43:10.130][INFO][1][9tq3vz71] stream=${INGEST}`,
      INGEST.replace('ikbps=0,4812,0', 'ikbps=0,-4812,0'),
      '[2026-10-03 17:43:52.000][INFO][1][p1ay3r01] -> PLA time=30010, msgs=12, okbps=4790,4801,0, ikbps=0,0,0, mw=350/8',
      // A colour code's shape behind any byte but the escape byte is not one.
      `x[0m${INGEST}`,
    ];
    const read = lines.filter((line) => parseRtmpPublishReport(line) !== null);

    assert.equal(read.length, 6, 'the six lines the parser reads, as its own cases above say');
    assert.deepEqual(keptByGrep(lines), read);
  });
});
