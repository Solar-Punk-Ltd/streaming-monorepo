import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  BUTTON_BAND,
  BUTTON_SIZE,
  type Bounds,
  clampRect,
  cursorFor,
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  defaultRect,
  GEOMETRY_STORAGE_KEY,
  loadGeometry,
  MIN_PANEL_SIZE,
  moveRect,
  parseSavedGeometry,
  type Rect,
  type ResizeEdge,
  resizeRect,
  saveGeometry,
} from '../src/components/SwarmHlsPlayer/overlays/qoe/qoeGeometry';

const BOUNDS: Bounds = { width: 1000, height: 800 };
const MIN = MIN_PANEL_SIZE;
/** A panel well inside the player, with room on every side. */
const START: Rect = { x: 300, y: 200, width: 300, height: 300 };

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

describe('resizeRect: which sides move', () => {
  const cases: Array<{ edge: ResizeEdge; moves: Array<'left' | 'right' | 'top' | 'bottom'> }> = [
    { edge: 'n', moves: ['top'] },
    { edge: 's', moves: ['bottom'] },
    { edge: 'e', moves: ['right'] },
    { edge: 'w', moves: ['left'] },
    { edge: 'ne', moves: ['top', 'right'] },
    { edge: 'nw', moves: ['top', 'left'] },
    { edge: 'se', moves: ['bottom', 'right'] },
    { edge: 'sw', moves: ['bottom', 'left'] },
  ];

  for (const { edge, moves } of cases) {
    it(`the ${edge} handle moves ${moves.join(' and ')} by the drag and holds the other sides`, () => {
      const r = resizeRect(START, edge, 20, 30, BOUNDS, MIN);

      assert.equal(r.x, START.x + (moves.includes('left') ? 20 : 0), 'left');
      assert.equal(right(r), right(START) + (moves.includes('right') ? 20 : 0), 'right');
      assert.equal(r.y, START.y + (moves.includes('top') ? 30 : 0), 'top');
      assert.equal(bottom(r), bottom(START) + (moves.includes('bottom') ? 30 : 0), 'bottom');
    });
  }

  it('does not change the rect it was given', () => {
    const start = { ...START };
    resizeRect(start, 'se', 50, 50, BOUNDS, MIN);
    assert.deepEqual(start, START);
  });
});

describe('resizeRect: the minimum size holds the opposite edge', () => {
  it('stops the w edge at the minimum width with the right edge unmoved', () => {
    const r = resizeRect(START, 'w', 1000, 0, BOUNDS, MIN);
    assert.equal(r.width, MIN.width);
    assert.equal(right(r), right(START));
  });

  it('stops the e edge at the minimum width with the left edge unmoved', () => {
    const r = resizeRect(START, 'e', -1000, 0, BOUNDS, MIN);
    assert.equal(r.width, MIN.width);
    assert.equal(r.x, START.x);
  });

  it('stops the n edge at the minimum height with the bottom edge unmoved', () => {
    const r = resizeRect(START, 'n', 0, 1000, BOUNDS, MIN);
    assert.equal(r.height, MIN.height);
    assert.equal(bottom(r), bottom(START));
  });

  it('stops the s edge at the minimum height with the top edge unmoved', () => {
    const r = resizeRect(START, 's', 0, -1000, BOUNDS, MIN);
    assert.equal(r.height, MIN.height);
    assert.equal(r.y, START.y);
  });

  it('stops a corner at the minimum on both axes, holding the opposite corner', () => {
    const r = resizeRect(START, 'nw', 1000, 1000, BOUNDS, MIN);
    assert.deepEqual(r, {
      x: right(START) - MIN.width,
      y: bottom(START) - MIN.height,
      width: MIN.width,
      height: MIN.height,
    });
  });
});

describe('resizeRect: the player bounds', () => {
  it('stops the w edge at the player left', () => {
    const r = resizeRect(START, 'w', -1000, 0, BOUNDS, MIN);
    assert.equal(r.x, 0);
    assert.equal(right(r), right(START));
  });

  it('stops the e edge at the player right', () => {
    const r = resizeRect(START, 'e', 1000, 0, BOUNDS, MIN);
    assert.equal(right(r), BOUNDS.width);
    assert.equal(r.x, START.x);
  });

  it('stops the s edge at the player bottom', () => {
    const r = resizeRect(START, 's', 0, 1000, BOUNDS, MIN);
    assert.equal(bottom(r), BOUNDS.height);
    assert.equal(r.y, START.y);
  });

  it('stops the n edge where the toggle button above the panel meets the player top', () => {
    const r = resizeRect(START, 'n', 0, -1000, BOUNDS, MIN);
    assert.equal(r.y, BUTTON_BAND);
    assert.equal(bottom(r), bottom(START));
  });

  it('clamps a corner on both axes at once', () => {
    const r = resizeRect(START, 'ne', 1000, -1000, BOUNDS, MIN);
    assert.deepEqual(r, {
      x: START.x,
      y: BUTTON_BAND,
      width: BOUNDS.width - START.x,
      height: bottom(START) - BUTTON_BAND,
    });
  });
});

describe('moveRect', () => {
  it('moves the rect by the drag and keeps its size', () => {
    assert.deepEqual(moveRect(START, -40, 25, BOUNDS), { ...START, x: START.x - 40, y: START.y + 25 });
  });

  it('stops at the player left', () => {
    assert.deepEqual(moveRect(START, -1000, 0, BOUNDS), { ...START, x: 0 });
  });

  it('stops at the player right', () => {
    assert.deepEqual(moveRect(START, 1000, 0, BOUNDS), { ...START, x: BOUNDS.width - START.width });
  });

  it('stops with the toggle button at the player top', () => {
    assert.deepEqual(moveRect(START, 0, -1000, BOUNDS), { ...START, y: BUTTON_BAND });
  });

  it('stops at the player bottom', () => {
    assert.deepEqual(moveRect(START, 0, 1000, BOUNDS), { ...START, y: BOUNDS.height - START.height });
  });
});

describe('clampRect', () => {
  it('leaves a rect that fits as it is', () => {
    assert.deepEqual(clampRect(START, BOUNDS, MIN), START);
  });

  it('shrinks an oversize rect to the player, below the button band', () => {
    const r = clampRect({ x: 0, y: BUTTON_BAND, width: 2000, height: 2000 }, BOUNDS, MIN);
    assert.deepEqual(r, { x: 0, y: BUTTON_BAND, width: BOUNDS.width, height: BOUNDS.height - BUTTON_BAND });
  });

  it('brings a rect lying wholly outside the player back to the nearest corner', () => {
    assert.deepEqual(clampRect({ x: 5000, y: 5000, width: 300, height: 300 }, BOUNDS, MIN), {
      x: BOUNDS.width - 300,
      y: BOUNDS.height - 300,
      width: 300,
      height: 300,
    });
    assert.deepEqual(clampRect({ x: -5000, y: -5000, width: 300, height: 300 }, BOUNDS, MIN), {
      x: 0,
      y: BUTTON_BAND,
      width: 300,
      height: 300,
    });
  });

  it('pulls a partly outside rect inside without changing its size', () => {
    assert.deepEqual(clampRect({ x: 900, y: 10, width: 300, height: 300 }, BOUNDS, MIN), {
      x: BOUNDS.width - 300,
      y: BUTTON_BAND,
      width: 300,
      height: 300,
    });
  });

  it('grows a rect below the minimum to the minimum', () => {
    const r = clampRect({ x: 100, y: 100, width: 10, height: 10 }, BOUNDS, MIN);
    assert.deepEqual(r, { x: 100, y: 100, width: MIN.width, height: MIN.height });
  });
});

describe('a player smaller than the minimum panel and its button band', () => {
  const TINY: Bounds = { width: 100, height: 100 };

  it('keeps the minimum size, aligns to the right and to the top, so the toggle button stays inside', () => {
    const r = clampRect({ x: 0, y: 0, width: 500, height: 500 }, TINY, MIN);

    assert.equal(r.width, MIN.width);
    assert.equal(r.height, MIN.height);
    assert.equal(right(r), TINY.width);
    assert.equal(r.y, BUTTON_BAND);
    // The button sits on the panel's top-right corner, so it is inside the player.
    assert.ok(right(r) - BUTTON_SIZE >= 0);
    assert.ok(r.y - BUTTON_BAND >= 0);
  });

  it('keeps that place under a move', () => {
    const start = clampRect({ x: 0, y: 0, width: 500, height: 500 }, TINY, MIN);
    assert.deepEqual(moveRect(start, -50, 50, TINY), start);
    assert.deepEqual(moveRect(start, 50, -50, TINY), start);
  });

  it('never resizes below the minimum', () => {
    const start = clampRect({ x: 0, y: 0, width: 500, height: 500 }, TINY, MIN);
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      const r = resizeRect(start, edge, 30, 30, TINY, MIN);
      assert.ok(r.width >= MIN.width, edge);
      assert.ok(r.height >= MIN.height, edge);
    }
  });

  it('makes the default the minimum in the same place', () => {
    const r = defaultRect(TINY);
    assert.deepEqual(r, { x: TINY.width - MIN.width, y: BUTTON_BAND, width: MIN.width, height: MIN.height });
  });
});

describe('defaultRect', () => {
  it('puts the toggle button where it always opened, 50 px from the right and 10 px from the top', () => {
    const r = defaultRect(BOUNDS);
    assert.equal(right(r) - BUTTON_SIZE, BOUNDS.width - 50);
    assert.equal(r.y - BUTTON_BAND, 10);
    assert.equal(r.width, DEFAULT_PANEL_WIDTH);
    assert.equal(r.height, DEFAULT_PANEL_HEIGHT);
  });

  it('shortens the panel to the space down to the player bottom', () => {
    const r = defaultRect({ width: 1000, height: 300 });
    assert.equal(bottom(r), 300);
    assert.equal(r.y - BUTTON_BAND, 10);
  });
});

describe('parseSavedGeometry', () => {
  const GOOD = { x: 10, y: 50, width: 200, height: 150 };

  it('is null for nothing saved', () => {
    assert.equal(parseSavedGeometry(null), null);
    assert.equal(parseSavedGeometry(''), null);
  });

  it('is null for a value that is not JSON or not an object', () => {
    for (const raw of ['{', 'not json', 'null', '42', '"text"', '[1,2,3,4]']) {
      assert.equal(parseSavedGeometry(raw), null, raw);
    }
  });

  it('is null when a field is missing, not a number or not finite', () => {
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const missing: Record<string, unknown> = { ...GOOD };
      delete missing[field];
      assert.equal(parseSavedGeometry(JSON.stringify(missing)), null, `${field} missing`);
      assert.equal(parseSavedGeometry(JSON.stringify({ ...GOOD, [field]: '10' })), null, `${field} a string`);
      // JSON has no Infinity or NaN; both serialise as null.
      assert.equal(parseSavedGeometry(JSON.stringify({ ...GOOD, [field]: Infinity })), null, `${field} infinite`);
      assert.equal(
        parseSavedGeometry(`{"x":10,"y":50,"width":200,"height":150,"${field}":1e999}`),
        null,
        `${field} 1e999`,
      );
    }
  });

  it('is null for a size that is not positive', () => {
    assert.equal(parseSavedGeometry(JSON.stringify({ ...GOOD, width: 0 })), null);
    assert.equal(parseSavedGeometry(JSON.stringify({ ...GOOD, height: -5 })), null);
  });

  it('reads a good value, keeping only the four fields', () => {
    assert.deepEqual(parseSavedGeometry(JSON.stringify({ ...GOOD, extra: true })), GOOD);
  });
});

describe('loadGeometry and saveGeometry', () => {
  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    };
  }
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  it('uses one versioned key', () => {
    assert.equal(GEOMETRY_STORAGE_KEY, 'swarm-hls.qoe-overlay.v1');
  });

  it('round-trips a rect under that key', () => {
    const storage = memoryStorage();
    saveGeometry(storage, START);
    assert.deepEqual(JSON.parse(storage.items.get(GEOMETRY_STORAGE_KEY)!), START);
    assert.deepEqual(loadGeometry(storage), START);
  });

  it('reads nothing, and throws nothing, from storage that throws or is absent', () => {
    assert.equal(loadGeometry(throwing), null);
    assert.equal(loadGeometry(null), null);
    assert.doesNotThrow(() => saveGeometry(throwing, START));
    assert.doesNotThrow(() => saveGeometry(null, START));
  });

  it('reads nothing from a bad saved value', () => {
    const storage = memoryStorage();
    storage.items.set(GEOMETRY_STORAGE_KEY, '{"x":1');
    assert.equal(loadGeometry(storage), null);
  });
});

describe('cursorFor', () => {
  it('shows the direction of each edge and corner', () => {
    assert.equal(cursorFor('n'), 'ns-resize');
    assert.equal(cursorFor('s'), 'ns-resize');
    assert.equal(cursorFor('e'), 'ew-resize');
    assert.equal(cursorFor('w'), 'ew-resize');
    assert.equal(cursorFor('nw'), 'nwse-resize');
    assert.equal(cursorFor('se'), 'nwse-resize');
    assert.equal(cursorFor('ne'), 'nesw-resize');
    assert.equal(cursorFor('sw'), 'nesw-resize');
  });
});
