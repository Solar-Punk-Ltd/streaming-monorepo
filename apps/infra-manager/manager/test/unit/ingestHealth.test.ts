/**
 * What the manager makes of SRS's own ingest statistics for one deployment.
 *
 * Unit test, no Docker and no database. `pnpm test` in manager/.
 *
 * On 2026-09-22 an outside tester's SRT broadcast came out with broken blocks
 * of picture for five hours and nothing on any screen said so. SRS had been
 * printing the reason every ten seconds: about six percent of the packets
 * dropped. This is the read of those lines, and the reading has to carry
 * numbers and a verdict and nothing else, because the same log carries the
 * webhook URL with the uploader's token in it and the publisher's address.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  INGEST_NOT_RUNNING,
  INGEST_NOT_SRS,
  INGEST_READ,
  INGEST_UNREADABLE,
  type IngestHealthReading,
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
import { TRANSPORT_STATS_MARKER } from '../../src/domain/ingestHealth/transportStatsLine.js';
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

/** Everything else a live SRS log carries around the reports. */
const SECRET_BEARING = [
  '[2026-09-22 17:33:40.101][INFO][1][4ek6chsn] SRT: publish stream=live/stream, peer ip=203.0.113.7:51514',
  '[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish ok, client_id=4ek6chsn, url=http://stream-uploader:3000/engines/srs/streams?token=abc123, response={"code":0}',
  '\u001b[33m[2026-09-22 17:33:50.901][WARN][1][4ek6chsn] RCV-DROPPED 1 packet(s). Packet seqno %861816580 delayed for 4.5 ms\u001b[0m',
  `[2026-09-22 17:33:51.000][INFO][1][4ek6chsn] url=http://srs/?token=abc123 ${TRANSPORT_STATS_MARKER}pktRecv=1, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0`,
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

describe('what an ingest reading may carry', () => {
  const SECRETS = ['abc123', 'token', '203.0.113.7', 'stream-uploader', '4ek6chsn', 'RCV-DROPPED', 'SRT_CPB'];
  const STATES = [
    INGEST_READ,
    INGEST_NOT_RUNNING,
    INGEST_UNREADABLE,
    INGEST_NOT_SRS,
    SRT_INGEST_MEASURED,
    SRT_INGEST_NO_REPORTS,
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

  it('hands on numbers and the verdict from a log that carries a token beside the reports', async (t) => {
    const logged = captureLogs(t);
    const { service } = serviceOver([...SECRET_BEARING, FIRST, SECOND]);

    const reading = await service.read('stage');

    assert.equal(reading.state === INGEST_READ && reading.srt.state, SRT_INGEST_MEASURED);
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
