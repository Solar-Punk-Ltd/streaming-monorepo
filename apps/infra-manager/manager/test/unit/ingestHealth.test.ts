/**
 * What the manager makes of SRS's own ingest statistics for one deployment.
 *
 * Unit test, no Docker and no database. `pnpm test` in manager/.
 *
 * On 2026-09-22 an outside SRT broadcast came out with broken blocks
 * of picture for five hours and nothing on any screen said so. SRS had been
 * printing the reason every ten seconds: about six percent of the packets
 * dropped. This is the read of those lines, and of SRS's line for each RTMP
 * publisher beside them. The reading has to carry numbers and states and
 * nothing else, because the same log carries the webhook URL with the
 * uploader's token in it, the publisher's address and an RTMP stream key.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it, type TestContext } from 'node:test';

import {
  INGEST_NOT_RUNNING,
  INGEST_NOT_SRS,
  INGEST_READ,
  INGEST_UNREADABLE,
  type IngestHealthReading,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_NO_REPORTS,
  RTMP_INGEST_UNATTRIBUTED,
  type RtmpIngestReading,
  SRS_SERVICE,
  SRT_INGEST_MEASURED,
  SRT_INGEST_NO_REPORTS,
  SRT_LINK_BAD,
  SRT_LINK_DEGRADED,
  SRT_LINK_HEALTHY,
  type SrtIngestReading,
} from '@streaming-infra-manager/common';

import {
  ContainerNotRunningError,
  DockerUnavailableError,
  ProfileNotFoundError,
} from '../../src/domain/errors/index.js';
import { Logger } from '../../src/domain/Logger.js';
import type { LogWindow } from '../../src/domain/logWindow.js';
import type { MarkedLines } from '../../src/domain/ports/remoteLogLines.js';
import {
  INGEST_LOG_LINES,
  INGEST_LOG_WINDOW,
  IngestHealthService,
  type MarkedLogLines,
} from '../../src/domain/ingestHealth/IngestHealthService.js';
import { parseRtmpPublishReport } from '../../src/domain/ingestHealth/rtmpPublishReport.js';
import { parseTransportStatsLine } from '../../src/domain/ingestHealth/transportStatsLine.js';
import type { Profile } from '../../src/types/index.js';
import { InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

const FIRST =
  '[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397';
const SECOND =
  '[2026-09-22 17:34:00.410][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6457, pktRcvLoss=367, pktRcvRetrans=350, pktRcvDrop=366';
const RECONNECTED =
  '[2026-09-22 17:34:05.002][INFO][1][7hd0ka2p] <- SRT_CPB Transport Stats # pktRecv=1043, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0';
const CLEAN =
  '[2026-09-23 09:00:10.000][INFO][1][c1eanl1n] <- SRT_CPB Transport Stats # pktRecv=9000, pktRcvLoss=12, pktRcvRetrans=12, pktRcvDrop=0';
const ONE_DROP =
  '[2026-09-23 09:00:20.000][INFO][1][c1eanl1n] <- SRT_CPB Transport Stats # pktRecv=9000, pktRcvLoss=12, pktRcvRetrans=11, pktRcvDrop=1';

/** One RTMP publisher's report, as an image that names the vhost prints it. */
function rtmpReport(connection: string, vhost: string | null, incomingKbps: number): string {
  return (
    `[2026-10-03 17:43:50.386][INFO][1][${connection}] <- CPB time=40021, okbps=0,0,0, ` +
    `ikbps=0,${incomingKbps},0, mr=0/350, p1stpt=20000, pnt=5000${vhost === null ? '' : `, vhost=${vhost}`}`
  );
}

const INGEST_VHOST = '__defaultVhost__';
const ABR_VHOST = 'abr';

/** Everything else a live SRS log carries around the reports. */
const SECRET_BEARING = [
  '[2026-09-22 17:33:40.101][INFO][1][4ek6chsn] SRT: publish stream=live/stream, peer ip=203.0.113.7:51514',
  '[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish ok, client_id=4ek6chsn, url=http://stream-uploader:3000/engines/srs/streams?token=abc123, response={"code":0}',
  '\u001b[33m[2026-09-22 17:33:50.901][WARN][1][4ek6chsn] RCV-DROPPED 1 packet(s). Packet seqno %861816580 delayed for 4.5 ms\u001b[0m',
  `[2026-09-22 17:33:51.000][INFO][1][4ek6chsn] url=http://srs/?token=abc123 <- SRT_CPB Transport Stats # pktRecv=1, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0`,
  '[2026-10-03 17:43:10.120][INFO][1][9tq3vz71] connect app, tcUrl=rtmp://ingest.example.org:10062/video, pageUrl=, swfUrl=, schema=rtmp, vhost=ingest.example.org, port=10062, app=video, args=null',
  '[2026-10-03 17:43:10.130][INFO][1][9tq3vz71] client identified, type=fmle-publish, vhost=ingest.example.org, app=video, stream=1867808f, param=?key=abc123, duration=0ms',
  `[2026-10-03 17:43:10.140][INFO][1][9tq3vz71] stream=${rtmpReport('9tq3vz71', INGEST_VHOST, 4812)}`,
];

interface LogRead {
  project: string;
  service: string;
  lines: MarkedLines;
  window: LogWindow;
  host: string | null | undefined;
}

function serviceOver(
  answer: string[] | Error,
  profile: Partial<Profile> = {},
): { service: IngestHealthService; reads: LogRead[] } {
  const reads: LogRead[] = [];
  const logs: MarkedLogLines = {
    async logLinesContaining(project, service, lines, window, host) {
      reads.push({ project, service, lines, window, host });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const profiles = new InMemoryProfiles([makeProfile({ name: 'stage', ...profile })]);
  return { service: new IngestHealthService(profiles.asRepository(), logs), reads };
}

/** The SRT part of a reading that was read, failing the test for one that was not. */
async function srtOf(service: IngestHealthService): Promise<SrtIngestReading> {
  const reading = await service.read('stage');
  assert.equal(reading.state, INGEST_READ);
  if (reading.state !== INGEST_READ) throw new Error('the log was not read');
  return reading.srt;
}

/** The RTMP part of a reading of these lines. */
async function rtmpOver(lines: string[]): Promise<RtmpIngestReading> {
  const reading = await serviceOver(lines).service.read('stage');
  assert.equal(reading.state, INGEST_READ);
  if (reading.state !== INGEST_READ) throw new Error('the log was not read');
  return reading.rtmp;
}

describe('IngestHealthService.read', () => {
  it('sums the minute of SRT reports SRS printed into one verdict', async () => {
    const { service } = serviceOver([FIRST, SECOND]);

    const reading = await service.read('stage');
    assert.equal(reading.state, INGEST_READ);
    if (reading.state !== INGEST_READ) return;
    assert.equal(reading.windowSeconds, 60);
    const { srt } = reading;

    assert.equal(srt.state, SRT_INGEST_MEASURED);
    if (srt.state !== SRT_INGEST_MEASURED) return;
    assert.deepEqual(srt.counts, { received: 12_957, lost: 761, retransmitted: 731, dropped: 763 });
    assert.equal(srt.reports, 2);
    assert.equal(srt.connections, 1);
    assert.equal(srt.verdict, SRT_LINK_BAD);
    assert.ok(Math.abs((srt.percent.dropped ?? 0) - 5.889) < 0.001);
  });

  it('counts an SRT publisher that reconnected inside the window as two connections of one link', async () => {
    const { service } = serviceOver([FIRST, RECONNECTED]);

    const srt = await srtOf(service);

    assert.equal(srt.state, SRT_INGEST_MEASURED);
    if (srt.state !== SRT_INGEST_MEASURED) return;
    assert.equal(srt.connections, 2);
    assert.equal(srt.counts.received, 7_543);
  });

  it('calls an SRT link that lost packets and recovered every one of them healthy', async () => {
    const { service } = serviceOver([CLEAN]);

    assert.equal(((await srtOf(service)) as { verdict?: string }).verdict, SRT_LINK_HEALTHY);
  });

  it('calls an SRT link with a single dropped packet degraded', async () => {
    const { service } = serviceOver([CLEAN, ONE_DROP]);

    assert.equal(((await srtOf(service)) as { verdict?: string }).verdict, SRT_LINK_DEGRADED);
  });

  it("asks for the deployment's own srs log, over the last minute, on the host it runs on", async () => {
    const { service, reads } = serviceOver([FIRST], { host: 'edge' });

    await service.read('stage');

    assert.deepEqual(reads, [
      {
        project: 'stage',
        service: SRS_SERVICE,
        lines: INGEST_LOG_LINES,
        window: { sinceSeconds: 60, tailLines: 20_000 },
        host: 'edge',
      },
    ]);
    assert.deepEqual(INGEST_LOG_WINDOW, { sinceSeconds: 60, tailLines: 20_000 });
  });

  it('says there were no SRT reports rather than showing zeros', async () => {
    const { service } = serviceOver(SECRET_BEARING.slice(0, 3));

    assert.deepEqual(await service.read('stage'), {
      state: INGEST_READ,
      windowSeconds: 60,
      srt: { state: SRT_INGEST_NO_REPORTS },
      rtmp: { state: RTMP_INGEST_NO_REPORTS },
    });
  });

  it('says SRS is not running when the deployment has no srs container up', async () => {
    const { service } = serviceOver(new ContainerNotRunningError('stage', SRS_SERVICE));

    assert.deepEqual(await service.read('stage'), { state: INGEST_NOT_RUNNING, windowSeconds: 60 });
  });

  it('says the log could not be read for any other failure, and never throws for it', async (t) => {
    t.mock.method(console, 'debug', () => {});
    for (const failure of [new DockerUnavailableError(), new Error('Docker target probe failed')]) {
      const { service } = serviceOver(failure);

      assert.deepEqual(await service.read('stage'), { state: INGEST_UNREADABLE, windowSeconds: 60 });
    }
  });

  it('reads nothing for a deployment whose media server is not SRS', async () => {
    for (const profile of [{ components: ['ome', 'stream-uploader', 'bee-uploader'] }, { kind: 'viewer' as const }]) {
      const { service, reads } = serviceOver([FIRST], profile);

      assert.deepEqual(await service.read('stage'), { state: INGEST_NOT_SRS, windowSeconds: 60 });
      assert.deepEqual(reads, []);
    }
  });

  it('refuses a deployment this manager does not have', async () => {
    const { service } = serviceOver([FIRST]);

    await assert.rejects(() => service.read('missing'), ProfileNotFoundError);
  });
});

describe('the RTMP part of a reading', () => {
  it('counts the RTMP publishers on the ingest vhost and the bitrate SRS received from them', async () => {
    assert.deepEqual(
      await rtmpOver([rtmpReport('9tq3vz71', INGEST_VHOST, 4790), rtmpReport('9tq3vz71', INGEST_VHOST, 4812)]),
      { state: RTMP_INGEST_MEASURED, reports: 2, connections: 1, incomingKbps: 4812 },
    );
  });

  it("leaves out the ladder's rungs, which SRS also takes over RTMP onto their own vhost", async () => {
    const ladderOverRtmp = [
      rtmpReport('9tq3vz71', INGEST_VHOST, 6100),
      rtmpReport('r1080p01', ABR_VHOST, 5000),
      rtmpReport('r720p001', ABR_VHOST, 2800),
      rtmpReport('r480p001', ABR_VHOST, 1200),
    ];

    assert.deepEqual(await rtmpOver(ladderOverRtmp), {
      state: RTMP_INGEST_MEASURED,
      reports: 1,
      connections: 1,
      incomingKbps: 6100,
    });
  });

  it('says no RTMP publisher for an SRT broadcast whose ladder republishes its rungs over RTMP', async () => {
    const reading = await serviceOver([
      FIRST,
      rtmpReport('r1080p01', ABR_VHOST, 5000),
      rtmpReport('r720p001', ABR_VHOST, 2800),
    ]).service.read('stage');

    assert.equal(reading.state, INGEST_READ);
    if (reading.state !== INGEST_READ) return;
    assert.equal(reading.srt.state, SRT_INGEST_MEASURED);
    assert.deepEqual(reading.rtmp, { state: RTMP_INGEST_NO_REPORTS });
  });

  it('reports an RTMP broadcast as one, and as no SRT publisher rather than a broken SRT link', async () => {
    const reading = await serviceOver([rtmpReport('9tq3vz71', INGEST_VHOST, 4812)]).service.read('stage');

    assert.equal(reading.state, INGEST_READ);
    if (reading.state !== INGEST_READ) return;
    assert.deepEqual(reading.srt, { state: SRT_INGEST_NO_REPORTS });
    assert.equal(reading.rtmp.state, RTMP_INGEST_MEASURED);
  });

  it('says RTMP ingest cannot be told from the rungs on an SRS that does not name the vhost', async () => {
    const olderEngine = [rtmpReport('9tq3vz71', null, 6100), rtmpReport('r1080p01', null, 5000)];

    assert.deepEqual(await rtmpOver(olderEngine), { state: RTMP_INGEST_UNATTRIBUTED });
  });

  it('reads an SRS that names the vhost by what it names, over older lines left from before an upgrade', async () => {
    assert.deepEqual(await rtmpOver([rtmpReport('o1dl1ne5', null, 6100), rtmpReport('r1080p01', ABR_VHOST, 5000)]), {
      state: RTMP_INGEST_NO_REPORTS,
    });
    assert.equal(
      (await rtmpOver([rtmpReport('o1dl1ne5', null, 6100), rtmpReport('9tq3vz71', INGEST_VHOST, 6100)])).state,
      RTMP_INGEST_MEASURED,
    );
  });

  it('counts a publisher that reconnected twice, and only the connection still sending in the bitrate', async () => {
    assert.deepEqual(
      await rtmpOver([
        rtmpReport('f1rstcon', INGEST_VHOST, 4800),
        rtmpReport('f1rstcon', INGEST_VHOST, 4650),
        rtmpReport('sec0ndcn', INGEST_VHOST, 4900),
      ]),
      { state: RTMP_INGEST_MEASURED, reports: 3, connections: 2, incomingKbps: 4900 },
    );
  });

  it('adds up two publishers that send at once, each by its latest report', async () => {
    assert.deepEqual(
      await rtmpOver([
        rtmpReport('stream0a', INGEST_VHOST, 3000),
        rtmpReport('stream0b', INGEST_VHOST, 1000),
        rtmpReport('stream0a', INGEST_VHOST, 3100),
        rtmpReport('stream0b', INGEST_VHOST, 1200),
      ]),
      { state: RTMP_INGEST_MEASURED, reports: 4, connections: 2, incomingKbps: 4300 },
    );
  });

  it('has no bitrate yet for a connection SRS has not sampled for 30 seconds, rather than a bitrate of zero', async () => {
    assert.deepEqual(await rtmpOver([rtmpReport('n3wc0nnx', INGEST_VHOST, 0)]), {
      state: RTMP_INGEST_MEASURED,
      reports: 1,
      connections: 1,
      incomingKbps: null,
    });
    assert.deepEqual(
      await rtmpOver([rtmpReport('f1rstcon', INGEST_VHOST, 4800), rtmpReport('sec0ndcn', INGEST_VHOST, 0)]),
      { state: RTMP_INGEST_MEASURED, reports: 2, connections: 2, incomingKbps: null },
      'the bitrate of the connection that ended is not counted for the one that replaced it',
    );
  });
});

describe('the lines one read of the log keeps', () => {
  /** Lines through the host's own `grep -E`, which is what runs on the remote host. */
  function keptByGrep(lines: readonly string[]): string[] {
    const run = spawnSync('grep', ['-E', '-e', INGEST_LOG_LINES.hostPattern], {
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
    return run.stdout.split('\n').filter((line) => line !== '');
  }

  const parsed = (line: string) => parseTransportStatsLine(line) !== null || parseRtmpPublishReport(line) !== null;

  it('are, on a remote host, exactly the lines one of the two readers parses', () => {
    const lines = [
      FIRST,
      CLEAN,
      rtmpReport('9tq3vz71', INGEST_VHOST, 4812),
      rtmpReport('r1080p01', ABR_VHOST, 5000),
      rtmpReport('o1dl1ne5', null, 6100),
      ...SECRET_BEARING,
      `${rtmpReport('9tq3vz71', INGEST_VHOST, 4812)}, token=abc123`,
      `${FIRST}, token=abc123`,
    ];

    assert.deepEqual(keptByGrep(lines), lines.filter(parsed));
    assert.equal(lines.filter(parsed).length, 5);
  });

  it('carry the marker the reader filters on before parsing, SRT and RTMP alike', () => {
    for (const line of [FIRST, rtmpReport('9tq3vz71', INGEST_VHOST, 4812), rtmpReport('o1dl1ne5', null, 6100)]) {
      assert.ok(line.includes(INGEST_LOG_LINES.marker), line);
    }
  });
});

describe('what an ingest reading may carry', () => {
  const SECRETS = [
    'abc123',
    'token',
    '203.0.113.7',
    'stream-uploader',
    '4ek6chsn',
    'RCV-DROPPED',
    'SRT_CPB',
    '9tq3vz71',
    'r7u2ng48',
    'ingest.example.org',
    '1867808f',
    INGEST_VHOST,
    ABR_VHOST,
    'CPB',
  ];
  const STATES = [
    INGEST_READ,
    INGEST_NOT_RUNNING,
    INGEST_UNREADABLE,
    INGEST_NOT_SRS,
    SRT_INGEST_MEASURED,
    SRT_INGEST_NO_REPORTS,
    RTMP_INGEST_MEASURED,
    RTMP_INGEST_NO_REPORTS,
    RTMP_INGEST_UNATTRIBUTED,
  ];
  const VERDICTS = [SRT_LINK_HEALTHY, SRT_LINK_DEGRADED, SRT_LINK_BAD];

  /** Every string in the reading, which may only be its state and its verdict. */
  function stringsIn(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (value === null || typeof value !== 'object') return [];
    return Object.values(value).flatMap(stringsIn);
  }

  /** Every line logged from each level, with the logger at trace so a debug line the default level drops is read too. */
  function captureLogs(t: TestContext): string[] {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      t.mock.method(console, level, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
    }
    const previous = Logger.getInstance().setLevel('trace');
    t.after(() => Logger.getInstance().setLevel(previous));
    return lines;
  }

  function assertCarriesNothingFromTheLog(reading: IngestHealthReading, logged: string[]): void {
    const answered = JSON.stringify(reading);
    for (const secret of SECRETS) {
      assert.ok(!answered.includes(secret), `${secret} reached the reading: ${answered}`);
      assert.ok(!logged.join('\n').includes(secret), `${secret} reached the manager's own log`);
    }
    for (const text of stringsIn(reading)) {
      assert.ok([...STATES, ...VERDICTS].includes(text as never), `the reading carries the text ${text}`);
    }
  }

  it('hands on numbers, states and the verdict from a log that carries a token and a key beside the reports', async (t) => {
    const logged = captureLogs(t);
    const { service } = serviceOver([
      ...SECRET_BEARING,
      FIRST,
      rtmpReport('9tq3vz71', INGEST_VHOST, 4812),
      rtmpReport('r7u2ng48', ABR_VHOST, 2795),
      SECOND,
    ]);

    const reading = await service.read('stage');

    assert.equal(reading.state === INGEST_READ && reading.srt.state, SRT_INGEST_MEASURED);
    assert.equal(reading.state === INGEST_READ && reading.rtmp.state, RTMP_INGEST_MEASURED);
    assertCarriesNothingFromTheLog(reading, logged);
  });

  it('hands on no text from a failure either, whatever the failure said', async (t) => {
    const logged = captureLogs(t);
    const { service } = serviceOver(new Error(SECRET_BEARING[1]!));

    const reading = await service.read('stage');

    assert.equal(reading.state, INGEST_UNREADABLE);
    assertCarriesNothingFromTheLog(reading, logged);
    assert.ok(logged.length > 0, 'the failure is logged, as a kind');
  });
});
