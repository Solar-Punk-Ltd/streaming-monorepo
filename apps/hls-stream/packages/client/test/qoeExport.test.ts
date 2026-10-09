import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, it, vi } from 'vitest';

import { QoeOverlay } from '../src/components/SwarmHlsPlayer/overlays/qoe/QoeOverlay';
import { QoePanel } from '../src/components/SwarmHlsPlayer/overlays/qoe/QoePanel';
import { qoeContent } from '../src/components/SwarmHlsPlayer/overlays/qoe/qoeContent';
import {
  copyQoeExport,
  fileSafeTopic,
  QOE_COPY_REFUSED,
  qoeExportFileName,
  qoeExportJson,
  saveQoeExport,
} from '../src/components/SwarmHlsPlayer/overlays/qoe/qoeExport';
import { initialMetrics, type QoeMetrics } from '../src/components/SwarmHlsPlayer/overlays/qoe/useHlsQoeMetrics';
import type { PlayerRelease } from '../src/utils/playerRelease';

const RELEASE: PlayerRelease = { label: 'QA-build-2026-10-07', commit: '1702aff1b3f35866819f9b6c02307567165f3d05' };

/** A session some way in: every kind of value the panel rounds, a ladder with a current, a capped and an unaffordable rung. */
function busyMetrics(): QoeMetrics {
  return {
    ...initialMetrics(),
    startupTimeMs: 1234.4,
    firstFrameTimeMs: 1500.6,
    rebufferingCount: 2,
    rebufferingDurationMs: 845.5,
    rebufferingRatio: 0.01234,
    hadRebuffering: true,
    bitrateKbps: 2400,
    resolution: '1280x720',
    qualitySwitchCount: 3,
    qualitySwitchPerMin: 1.23456,
    droppedFrames: 4,
    abrEnabled: true,
    selectedHeight: 720,
    bandwidthEstimateKbps: 5123,
    ladder: [
      { height: 480, bitrateKbps: 1200, current: false, capped: false, unaffordable: false },
      { height: 720, bitrateKbps: 2400, current: true, capped: false, unaffordable: false },
      { height: 1080, bitrateKbps: 4800, current: false, capped: true, unaffordable: true },
    ],
    nextHeight: 720,
    lastSwitchLatencyMs: 812.2,
    avgSwitchLatencyMs: 905.75,
    maxSwitchLatencyMs: 6001,
    switchLatencySamples: 3,
    fatalErrorCount: 1,
    reconnectAttempts: 2,
    reconnectSuccesses: 1,
    reconnectSuccessRate: 0.5,
    lastRecoveryTimeMs: 3210.9,
    liveLatencySec: 7.456,
    liveTargetLatencySec: 9.1,
    bufferStallCount: 1,
    playbackTimeMs: 45678.2,
  };
}

/** React's escapes in text and attributes, undone. */
function text(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

const ROW_RE =
  /<div class="qoe-overlay__row(?: qoe-overlay__row--bad)?"><span class="qoe-overlay__label">([^<]*)<\/span><span class="qoe-overlay__value">([^<]*)<\/span><\/div>/g;

/** What the rendered panel shows, read back out of its markup in the export's own shape. */
function readPanel(html: string): unknown {
  const title = /<span class="qoe-overlay__title">([^<]*)<\/span>/.exec(html)?.[1];
  const player =
    /qoe-overlay__release"><span class="qoe-overlay__label">Player<\/span><span class="qoe-overlay__value"[^>]*>([^<]*)<\/span>/.exec(
      html,
    )?.[1];
  const sections = html
    .split('<div class="qoe-overlay__section">')
    .slice(1)
    .map((part) => ({
      title: text(/^<div class="qoe-overlay__section-title">([^<]*)<\/div>/.exec(part)![1]!),
      rows: [...part.split('<div class="qoe-overlay__footer">')[0]!.matchAll(ROW_RE)].map(([, label, value]) => ({
        label: text(label!),
        value: text(value!),
      })),
    }));
  const footer = /<div class="qoe-overlay__footer">([^<]*)<\/div>/.exec(html)?.[1];
  return {
    title: text(title!),
    ...(player !== undefined ? { player: text(player) } : {}),
    sections,
    footer: text(footer!),
  };
}

function renderPanel(metrics: QoeMetrics, release: PlayerRelease | null): string {
  return renderToStaticMarkup(createElement(QoePanel, { metrics, release, topic: 'stream-a' }));
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The QoE panel's Copy and Save export what the panel shows, as JSON: the same strings, rounding and all, and nothing
 * the panel does not show. The panel and the export are built by one function, `qoeContent`.
 */
describe('the QoE export', () => {
  it('is exactly what the panel renders, top to bottom, with its release line', () => {
    const metrics = busyMetrics();
    const exported = JSON.parse(qoeExportJson(qoeContent(metrics, RELEASE)));

    assert.deepEqual(exported, readPanel(renderPanel(metrics, RELEASE)));
    // The control: the reading of the markup found what is there.
    assert.equal(exported.player, 'QA-build-2026-10-07 (1702aff1b)');
    assert.deepEqual(
      exported.sections.map((section: { title: string }) => section.title),
      ['Startup', 'Rebuffering', 'Quality', 'Live', 'ABR', 'Reliability'],
    );
    assert.equal(exported.sections[4].rows.length, 11, 'the seven ABR rows, three rungs and what ABR would pick');
  });

  it('carries the panel’s rounding and its ladder labels as shown, never a raw number', () => {
    const exported = JSON.parse(qoeExportJson(qoeContent(busyMetrics(), RELEASE)));
    const rows = new Map<string, string>(
      exported.sections.flatMap((section: { rows: { label: string; value: string }[] }) =>
        section.rows.map((row) => [row.label, row.value]),
      ),
    );

    assert.equal(rows.get('Startup Time'), '1234 ms');
    assert.equal(rows.get('Ratio'), '1.2%');
    assert.equal(rows.get('Switch Frequency'), '1.23/min');
    assert.equal(rows.get('E2E Live Latency'), '7.46 s');
    assert.equal(rows.get('▸ 720p'), '2400 kbps');
    assert.equal(rows.get('  1080p'), '4800 kbps · capped · unaffordable');
    assert.equal(rows.get('ABR would pick'), '720p');
    assert.equal(exported.footer, 'Playback: 45678 ms');
    for (const value of rows.values()) assert.equal(typeof value, 'string');
  });

  it('is the panel with no release line and no player key when the build named no release', () => {
    const metrics = initialMetrics();
    const exported = JSON.parse(qoeExportJson(qoeContent(metrics, null)));

    assert.deepEqual(exported, readPanel(renderPanel(metrics, null)));
    assert.equal('player' in exported, false);
    assert.equal(exported.title, 'QoE Metrics');
  });

  it('holds only the panel’s strings: no colour, no field the panel does not print', () => {
    const exported = JSON.parse(qoeExportJson(qoeContent(busyMetrics(), RELEASE)));

    assert.deepEqual(Object.keys(exported), ['title', 'player', 'sections', 'footer']);
    for (const section of exported.sections) {
      assert.deepEqual(Object.keys(section), ['title', 'rows']);
      for (const row of section.rows) assert.deepEqual(Object.keys(row), ['label', 'value']);
    }
  });

  it('is pretty-printed with two spaces', () => {
    const json = qoeExportJson(qoeContent(initialMetrics(), RELEASE));

    assert.match(json, /^\{\n {2}"title": "QoE Metrics",\n {2}"player": /);
    assert.equal(json, JSON.stringify(JSON.parse(json), null, 2));
  });

  it('is offered by Copy and Save in the panel’s header, above the release line', () => {
    const html = renderToStaticMarkup(createElement(QoeOverlay, { metrics: initialMetrics(), release: RELEASE }));
    const header = /<div class="qoe-overlay__header">(.*?)<\/div>/.exec(html)?.[1] ?? '';

    assert.match(header, /<button[^>]*>Copy<\/button>/);
    assert.match(header, /<button[^>]*>Save<\/button>/);
    assert.ok(html.indexOf('qoe-overlay__header') < html.indexOf('qoe-overlay__release'));
  });
});

describe('the saved file’s name', () => {
  it('is qoe-<stream>-<YYYYMMDD-HHMMSS>.json, at the viewer’s own time', () => {
    assert.equal(qoeExportFileName('stream-a', new Date(2026, 9, 9, 7, 5, 3)), 'qoe-stream-a-20261009-070503.json');
    assert.equal(qoeExportFileName('stream-a', new Date(2026, 0, 31, 23, 59, 59)), 'qoe-stream-a-20260131-235959.json');
  });

  it('makes the topic file-safe', () => {
    assert.equal(fileSafeTopic('my stream/2026: live?'), 'my-stream-2026-live');
    assert.equal(fileSafeTopic('../etc/passwd'), 'etc-passwd');
    assert.equal(fileSafeTopic('Stream_1.v2'), 'Stream_1.v2');
    assert.equal(fileSafeTopic('ü'.repeat(10)), 'stream');
    assert.equal(fileSafeTopic(''), 'stream');
    assert.equal(fileSafeTopic(undefined), 'stream');
    assert.equal(fileSafeTopic('a'.repeat(200)).length, 64);
  });
});

describe('Copy', () => {
  it('puts the JSON on the clipboard', async () => {
    const written: string[] = [];
    const outcome = await copyQoeExport('{"a":1}', {
      clipboard: { writeText: async (value: string) => void written.push(value) },
    });

    assert.equal(outcome, 'copied');
    assert.deepEqual(written, ['{"a":1}']);
  });

  it('falls back to copying a selection where the browser refuses the clipboard', async () => {
    const selected: string[] = [];
    const outcome = await copyQoeExport('{"a":1}', {
      clipboard: {
        writeText: async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError');
        },
      },
      copySelection: (value) => {
        selected.push(value);
        return true;
      },
    });

    assert.equal(outcome, 'copied');
    assert.deepEqual(selected, ['{"a":1}']);
  });

  it('says refused where the browser takes neither, as on a page served over plain http, and points to Save', async () => {
    assert.equal(await copyQoeExport('{}', { clipboard: undefined, copySelection: () => false }), 'refused');
    assert.equal(
      await copyQoeExport('{}', {
        clipboard: undefined,
        copySelection: () => {
          throw new Error('not allowed');
        },
      }),
      'refused',
    );
    assert.match(QOE_COPY_REFUSED, /Save still works/);
  });
});

describe('Save', () => {
  it('downloads the JSON under the file name, and lets the address go after the click', () => {
    vi.useFakeTimers();
    const clicked: { href: string; download: string }[] = [];
    const appended: unknown[] = [];
    let removed = 0;
    const revoked: string[] = [];
    let blob: Blob | null = null;
    const link = {
      href: '',
      download: '',
      rel: '',
      click() {
        clicked.push({ href: this.href, download: this.download });
      },
      remove() {
        removed += 1;
      },
    };

    saveQoeExport('{"a":1}', 'qoe-stream-a-20261009-070503.json', {
      document: {
        createElement: (() => link) as unknown as Document['createElement'],
        body: { appendChild: (node: unknown) => appended.push(node) } as unknown as HTMLElement,
      },
      url: {
        createObjectURL: (object: Blob | MediaSource) => {
          blob = object as Blob;
          return 'blob:qoe-1';
        },
        revokeObjectURL: (href: string) => void revoked.push(href),
      },
    });

    assert.deepEqual(clicked, [{ href: 'blob:qoe-1', download: 'qoe-stream-a-20261009-070503.json' }]);
    assert.equal(appended.length, 1);
    assert.equal(removed, 1);
    assert.equal((blob as Blob | null)?.type, 'application/json');
    assert.deepEqual(revoked, []);
    vi.runAllTimers();
    assert.deepEqual(revoked, ['blob:qoe-1']);
  });
});
