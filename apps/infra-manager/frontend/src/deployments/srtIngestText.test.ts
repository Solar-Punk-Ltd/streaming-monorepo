/**
 * The words the ingest card's SRT part turns a reading into.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The card exists because an outside broadcast broke up for five hours on
 * 2026-09-22 and nothing on any screen said so, while SRS was counting six
 * percent of the packets dropped. So a bad link has to read as bad, with the
 * fix beside it. A minute with no reports is the card's as a whole, and
 * `ingestHealthText.test.ts` covers it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INGEST_READ,
  measuredSrtIngest,
  RTMP_INGEST_NO_REPORTS,
  type SrtLinkCounts,
} from '@streaming-infra-manager/common';

import { type IngestHealthView, ingestHealthView } from './ingestHealthText';
import { offersLatencySetting, RAISE_LATENCY_ACTION, type SrtIngestSection } from './srtIngestText';

const measured = (counts: SrtLinkCounts, reports = 6, connections = 1) => ({
  state: INGEST_READ,
  windowSeconds: 60,
  srt: measuredSrtIngest({ reports, connections, counts }),
  rtmp: { state: RTMP_INGEST_NO_REPORTS },
});

/** The whole card for a minute of SRT reports. */
const card = (reading: ReturnType<typeof measured>, latencySettingOffered = false): IngestHealthView =>
  ingestHealthView({ reading, loadError: null }, { latencySettingOffered });

/** The card's SRT part, which a measured minute always has. */
function read(reading: ReturnType<typeof measured>, latencySettingOffered = false): SrtIngestSection {
  const { srt } = card(reading, latencySettingOffered);
  assert.ok(srt, 'the card shows an SRT part');
  return srt;
}

const BROKEN_UP = measured({ received: 12_957, lost: 761, retransmitted: 731, dropped: 763 }, 2);
const ONE_DROP = measured({ received: 38_000, lost: 40, retransmitted: 39, dropped: 3 });
const RECOVERED = measured({ received: 39_000, lost: 120, retransmitted: 120, dropped: 0 });
const CLEAN = measured({ received: 39_000, lost: 0, retransmitted: 0, dropped: 0 });
const CLEAN_COUNTS: SrtLinkCounts = { received: 9_000, lost: 0, retransmitted: 0, dropped: 0 };

function allText(section: SrtIngestSection): string[] {
  return [
    section.summary,
    section.verdict,
    ...section.rows.flatMap((row) => [row.label, row.value, row.detail]),
    section.remedy?.title ?? '',
    ...(section.remedy?.steps.map((step) => step.text) ?? []),
  ];
}

describe('a measured SRT link on the card', () => {
  it('calls the broadcast that broke up bad, and says why in plain words', () => {
    const view = read(BROKEN_UP);

    assert.deepEqual(card(BROKEN_UP).pill, { label: 'Bad', tone: 'err' });
    assert.equal(view.summary, 'From the 2 reports SRS printed in the last 60 seconds, over 1 SRT connection.');
    assert.equal(view.verdict, '1% or more of the packets were dropped, so the picture is breaking up.');
    assert.deepEqual(
      view.rows.map((row) => [row.label, row.value]),
      [
        ['Packets received', '12,957'],
        ['Lost', '5.9% · 761 packets'],
        ['Retransmitted', '5.6% · 731 packets'],
        ['Dropped', '5.9% · 763 packets'],
      ],
    );
  });

  it('gives the remedy beside a bad link, as an error', () => {
    const remedy = read(BROKEN_UP).remedy;

    assert.equal(remedy?.severity, 'error');
    assert.equal(
      remedy?.title,
      "The broadcaster's connection is losing packets, and some arrive too late to use, so the picture breaks up.",
    );
    const steps = remedy?.steps.map((step) => step.text) ?? [];
    assert.equal(steps.length, 4);
    assert.match(steps[0]!, /Raise the SRT latency of this deployment, to 4000 ms for example\./);
    assert.equal(
      steps[1],
      'Or add &latency=4000000 to the end of the SRT address in OBS. OBS counts microseconds, so that is 4 seconds. SRT uses the larger of the two sides, so this only helps when it is above the SRT latency this deployment runs with.',
    );
    assert.equal(steps[2], 'Lower the bitrate OBS broadcasts at.');
    assert.equal(steps[3], 'Use a wired connection instead of WiFi.');
  });

  it('calls a link with a few dropped packets degraded, with the same remedy as a warning', () => {
    const view = read(ONE_DROP);

    assert.deepEqual(card(ONE_DROP).pill, { label: 'Degraded', tone: 'warn' });
    assert.equal(
      view.verdict,
      'Some packets arrived too late to use and were dropped, so the picture can break up in places.',
    );
    assert.equal(view.remedy?.severity, 'warning');
    assert.equal(view.remedy?.steps.length, 4);
    assert.equal(view.rows[3]!.value, '0.01% · 3 packets');
  });

  it('calls a link that recovered everything it lost healthy, and offers no remedy', () => {
    const view = read(RECOVERED);

    assert.deepEqual(card(RECOVERED).pill, { label: 'Healthy', tone: 'ok' });
    assert.equal(
      view.verdict,
      'Nothing was dropped. Every packet that went missing was sent again in time, so the picture is whole.',
    );
    assert.equal(view.remedy, null);
    assert.equal(view.rows[3]!.value, 'none');
  });

  it('says a clean link lost nothing, rather than a column of zero percentages', () => {
    const view = read(CLEAN);

    assert.equal(view.verdict, 'Nothing was lost and nothing was dropped.');
    assert.deepEqual(
      view.rows.map((row) => row.value),
      ['39,000', 'none', 'none', 'none'],
    );
  });

  it('names one report and several connections in the right number', () => {
    assert.equal(
      read(measured(CLEAN_COUNTS, 1, 2)).summary,
      'From the 1 report SRS printed in the last 60 seconds, over 2 SRT connections.',
    );
  });

  it('gives counts without a share when no packet arrived', () => {
    const nothingReceived = measured({ received: 0, lost: 0, retransmitted: 0, dropped: 4 }, 1);

    assert.deepEqual(
      read(nothingReceived).rows.map((row) => row.value),
      ['0', 'none', 'none', '4 packets'],
    );
    assert.deepEqual(card(nothingReceived).pill, { label: 'Bad', tone: 'err' });
  });

  // With nothing received there is no share to quote, so the verdict cannot
  // say what percentage was dropped.
  it('says a bad minute with no packet received was dropped, without quoting a share', () => {
    const { verdict } = read(measured({ received: 0, lost: 0, retransmitted: 0, dropped: 4 }, 1));

    assert.equal(verdict, 'SRS gave up on packets and received none, so the picture is breaking up.');
  });

  it('explains what each count is, in words', () => {
    assert.deepEqual(
      read(BROKEN_UP).rows.map((row) => row.detail),
      [
        'Data packets that reached SRS.',
        'Noticed missing on the way. SRT asks the broadcaster for these again.',
        'Arrived on a second try.',
        'Given up on and never delivered. These are the holes in the picture.',
      ],
    );
  });
});

describe('the SRT latency step of the remedy', () => {
  it("leads to the setting in the deployment's stack settings when this version offers it", () => {
    const [first] = read(BROKEN_UP, true).remedy!.steps;

    assert.equal(first!.action, RAISE_LATENCY_ACTION);
    assert.equal(
      first!.text,
      'Raise the SRT latency of this deployment, to 4000 ms for example, in its stack settings.',
    );
  });

  it('points at the OBS side when this version does not offer it', () => {
    const [first] = read(BROKEN_UP, false).remedy!.steps;

    assert.equal(first!.action, undefined);
    assert.equal(
      first!.text,
      "Raise the SRT latency of this deployment, to 4000 ms for example. Until this manager offers that setting, the change in OBS below does the same from the broadcaster's side.",
    );
  });

  // The deployment's own default is 2000 ms, and SRT runs at the larger of the
  // two sides, so an OBS value at or under it would change nothing.
  it('asks OBS for more latency than the deployment already runs with', () => {
    const obsStep = read(BROKEN_UP).remedy!.steps[1]!.text;
    const microseconds = Number(/&latency=(\d+)/.exec(obsStep)?.[1]);

    assert.ok(microseconds / 1_000 > 2_000, `OBS is asked for ${microseconds} microseconds`);
    assert.match(obsStep, /so that is 4 seconds\./);
  });

  // The card cannot see the wait this deployment runs with. The manager writes
  // 2000 ms, but SRS on stack v3.1 waits its own 120 on ingest whatever is set,
  // so any number named here is wrong for some deployment.
  it('names no latency the deployment is said to run with, with or without the setting', () => {
    for (const offered of [true, false]) {
      const obsStep = read(BROKEN_UP, offered).remedy!.steps[1]!.text;

      assert.doesNotMatch(obsStep, /\d+ ms/, `setting offered: ${offered}`);
    }
  });

  it('reads whether the setting is offered off the fields the engine card lists', () => {
    assert.equal(offersLatencySetting([{ key: 'HLS_FRAGMENT' }, { key: 'SRT_LATENCY' }]), true);
    assert.equal(offersLatencySetting([{ key: 'HLS_FRAGMENT' }]), false);
    assert.equal(offersLatencySetting(undefined), false);
  });
});

describe("the words on the card's SRT part", () => {
  it('carry no em dash and no semicolon, in any state', () => {
    const sections = [read(BROKEN_UP, true), read(BROKEN_UP, false), read(ONE_DROP), read(RECOVERED), read(CLEAN)];

    for (const text of sections.flatMap(allText)) {
      assert.ok(!text.includes('\u2014'), `an em dash in: ${text}`);
      assert.ok(!text.includes(';'), `a semicolon in: ${text}`);
    }
  });
});
