import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';

import { QoeOverlay } from '../src/components/SwarmHlsPlayer/overlays/qoe/QoeOverlay';
import { initialMetrics } from '../src/components/SwarmHlsPlayer/overlays/qoe/useHlsQoeMetrics';

/** The overlay as it first renders, panel open, which is how `?qoe=1` opens it. */
function render(): string {
  return renderToStaticMarkup(createElement(QoeOverlay, { metrics: initialMetrics(), release: null }));
}

const EDGES = [
  ['n', 'ns-resize'],
  ['s', 'ns-resize'],
  ['e', 'ew-resize'],
  ['w', 'ew-resize'],
  ['ne', 'nesw-resize'],
  ['nw', 'nwse-resize'],
  ['se', 'nwse-resize'],
  ['sw', 'nesw-resize'],
] as const;

/**
 * The open panel sits in a frame that carries a resize handle on each edge and corner, the way a
 * desktop window does. The geometry itself is tested in qoeGeometry.test.ts; this checks the markup.
 */
describe('the resize handles of the QoE panel', () => {
  it('has one handle on each of the 8 edges and corners, each with its direction cursor', () => {
    const html = render();
    const handles = html.match(/class="qoe-overlay__handle [^"]*"/g) ?? [];

    assert.equal(handles.length, 8);
    for (const [edge, cursor] of EDGES) {
      const handle = new RegExp(
        `<div class="qoe-overlay__handle qoe-overlay__handle--${edge}"[^>]*style="cursor:${cursor}"`,
      );
      assert.match(html, handle, edge);
    }
  });

  it('puts the panel and its handles in one frame', () => {
    const html = render();
    assert.match(html, /<div class="qoe-overlay__frame"[^>]*><div class="qoe-overlay__handle /);
    // Whatever the panel renders inside, it is the frame's child, after the handles.
    assert.match(html, /class="qoe-overlay__panel"/);
    // The handles come before the panel, so they stay put while the panel scrolls.
    assert.ok(html.lastIndexOf('qoe-overlay__handle') < html.indexOf('qoe-overlay__panel'));
  });
});
