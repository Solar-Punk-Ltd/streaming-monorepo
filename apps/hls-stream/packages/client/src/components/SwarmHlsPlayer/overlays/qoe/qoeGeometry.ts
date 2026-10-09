/**
 * Where the QoE overlay sits in the player and how big its panel is. Pure: no React, no DOM.
 *
 * The model is one rectangle, the panel's `{ x, y, width, height }` in the player's coordinates
 * (px from the top-left of the overlay's offsetParent). Everything else follows from it:
 *
 * - The toggle button sits on the panel's top-right corner, above it: the button's right edge is
 *   the panel's right edge and its bottom is 4 px above the panel's top. So the area the overlay
 *   occupies is the panel plus a band of `BUTTON_BAND` px above it, and that whole area is what is
 *   kept inside the player: `x >= 0`, `x + width <= player width`, `y >= BUTTON_BAND`,
 *   `y + height <= player height`.
 * - Dragging the button moves the rectangle (`moveRect`). Dragging an edge or a corner of the panel
 *   moves that edge and holds the opposite one (`resizeRect`); the n edge moves the panel's top, and
 *   the button with it.
 * - A hidden panel keeps its rectangle, size and all, and the button still derives from it. Only the
 *   button's own 32 px box is then kept inside the player (`moveButton`), so the rectangle may lie
 *   partly outside it: the panel isn't drawn, and its size must not box the button in. Shown again,
 *   the panel hangs at the button's corner with its last size and the pair is pulled back inside
 *   together (`panelAtButton`), the button moving with it if it has to.
 * - A saved or stale rectangle, and one whose player has just shrunk, is pulled back in by
 *   `clampRect`: shrunk to fit first, never below the minimum, then moved inside.
 *
 * When the player is smaller than the minimum panel plus the band, the minimum size wins: the panel
 * stays usable and spills out of the player rather than shrinking into something unreadable. It is
 * then aligned to the player's right edge and to the top just below the band, which keeps the toggle
 * button, the one control that hides the panel again, inside the player. It spills to the left and
 * the bottom.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The player's size: the overlay's offsetParent. */
export interface Bounds {
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The toggle button's top-left corner, in the player's coordinates. */
export interface Point {
  x: number;
  y: number;
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** The round toggle button, as QoeOverlay.scss draws it. */
export const BUTTON_SIZE = 32;
/** The space between the button's bottom and the panel's top. */
export const BUTTON_GAP = 4;
/** The band above the panel that the button occupies, which the bounds apply to as well. */
export const BUTTON_BAND = BUTTON_SIZE + BUTTON_GAP;

/**
 * The smallest panel. 160 px wide holds a short label and its value on one line at the panel's
 * 11 px monospace (about 20 characters after the padding), and lets a long row wrap onto two lines
 * rather than one word per line. 120 px tall shows the header and four or five rows, enough to read
 * a section and to see that the panel scrolls.
 */
export const MIN_PANEL_SIZE: Size = { width: 160, height: 120 };

/** The button's default place, where it has always opened: 50 px from the player's right, 10 from its top. */
export const DEFAULT_BUTTON_RIGHT_OFFSET = 50;
export const DEFAULT_BUTTON_TOP = 10;
/** Wide enough for every row of the panel on one line, the release row aside. */
export const DEFAULT_PANEL_WIDTH = 300;
/**
 * About two thirds of the panel's natural height, the old `max-height: 70vh` of a common laptop
 * window. It is shortened to the space down to the player's bottom when the player is smaller.
 */
export const DEFAULT_PANEL_HEIGHT = 420;

/** One key, versioned, so a later change of shape starts from the defaults instead of misreading. */
export const GEOMETRY_STORAGE_KEY = 'swarm-hls.qoe-overlay.v1';

/** Of Web Storage, the two calls the overlay needs, so a test can hand in a fake. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const finiteOr0 = (n: number) => (Number.isFinite(n) ? n : 0);

/**
 * The position of a span `size` long kept within `[lo, hi]`. When it can't fit, it aligns to `hi`
 * when `alignHigh`, otherwise to `lo` (see the module comment for why).
 */
function clampAxis(pos: number, size: number, lo: number, hi: number, alignHigh: boolean): number {
  if (size > hi - lo) {
    return alignHigh ? hi - size : lo;
  }
  return Math.min(Math.max(pos, lo), hi - size);
}

/** The position of `rect`, size kept, moved inside the player. */
function placeInside(rect: Rect, bounds: Bounds): Rect {
  return {
    x: clampAxis(rect.x, rect.width, 0, bounds.width, true),
    y: clampAxis(rect.y, rect.height, BUTTON_BAND, bounds.height, false),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * `start` with `edge` dragged by `(dx, dy)`. The opposite edge or corner stays fixed. A side stops at
 * the minimum size, still holding the opposite side, and at the player's bounds, the top at the
 * button band. The minimum wins over the bounds.
 */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, bounds: Bounds, min: Size): Rect {
  dx = finiteOr0(dx);
  dy = finiteOr0(dy);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (edge.includes('w')) {
    left = Math.min(right - min.width, Math.max(0, left + dx));
  } else if (edge.includes('e')) {
    right = Math.max(left + min.width, Math.min(bounds.width, right + dx));
  }
  if (edge.includes('n')) {
    top = Math.min(bottom - min.height, Math.max(BUTTON_BAND, top + dy));
  } else if (edge.includes('s')) {
    bottom = Math.max(top + min.height, Math.min(bounds.height, bottom + dy));
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `start` dragged by `(dx, dy)`, its size kept and its position kept inside the player. */
export function moveRect(start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return placeInside({ ...start, x: start.x + finiteOr0(dx), y: start.y + finiteOr0(dy) }, bounds);
}

/** `rect` shrunk to fit the player, never below `min`, then moved inside it. */
export function clampRect(rect: Rect, bounds: Bounds, min: Size): Rect {
  const width = Math.max(min.width, Math.min(rect.width, bounds.width));
  const height = Math.max(min.height, Math.min(rect.height, bounds.height - BUTTON_BAND));
  return placeInside({ x: rect.x, y: rect.y, width, height }, bounds);
}

/** The button of a panel rectangle: on its top-right corner, `BUTTON_GAP` px above it. */
export function buttonOf(rect: Rect): Point {
  return { x: rect.x + rect.width - BUTTON_SIZE, y: rect.y - BUTTON_BAND };
}

/** The panel rectangle of `size` hanging at `button`'s corner, as it is, unclamped. */
export function rectAtButton(button: Point, size: Size): Rect {
  return { x: button.x + BUTTON_SIZE - size.width, y: button.y + BUTTON_BAND, width: size.width, height: size.height };
}

/**
 * The button dragged by `(dx, dy)` while the panel is hidden: only its own box is kept inside the
 * player. In a player smaller than the button it aligns right and top, as the panel does.
 */
export function moveButton(button: Point, dx: number, dy: number, bounds: Bounds): Point {
  return {
    x: clampAxis(button.x + finiteOr0(dx), BUTTON_SIZE, 0, bounds.width, true),
    y: clampAxis(button.y + finiteOr0(dy), BUTTON_SIZE, 0, bounds.height, false),
  };
}

/**
 * A hidden panel's rectangle with its button dragged by `(dx, dy)`: the size kept, the rectangle
 * following the button, and only the button kept inside the player. With `dx = dy = 0`, the clamp
 * of a hidden panel when the player resizes.
 */
export function moveHiddenRect(start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return rectAtButton(moveButton(buttonOf(start), dx, dy, bounds), start);
}

/**
 * The panel shown again: `size` hung at `button`'s corner, then the pair shrunk to fit and moved
 * inside the player like any other rectangle (`clampRect`). The button is wherever the result puts it.
 */
export function panelAtButton(button: Point, size: Size, bounds: Bounds, min: Size): Rect {
  return clampRect(rectAtButton(button, size), bounds, min);
}

/**
 * Whether a reading of the player's size can be clamped to. A player that is hidden, display:none or
 * not laid out yet measures 0 on a side; clamping to that would crush the geometry, and the next drag
 * would save it. Such a reading is ignored and the geometry left as it was.
 */
export function usableBounds(bounds: Bounds | null | undefined): bounds is Bounds {
  return (
    bounds != null &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

/**
 * `rect` clamped again after the player resized: the panel and its button together while the panel
 * is shown, the button alone while it is hidden. Untouched for a reading that is not `usableBounds`.
 */
export function reclampRect(rect: Rect, bounds: Bounds, visible: boolean): Rect {
  if (!usableBounds(bounds)) {
    return rect;
  }
  return visible ? clampRect(rect, bounds, MIN_PANEL_SIZE) : moveHiddenRect(rect, 0, 0, bounds);
}

/** The panel when nothing is saved: the button where it has always opened, the panel below it. */
export function defaultRect(bounds: Bounds): Rect {
  const right = bounds.width - DEFAULT_BUTTON_RIGHT_OFFSET + BUTTON_SIZE;
  const y = DEFAULT_BUTTON_TOP + BUTTON_BAND;
  const height = Math.min(DEFAULT_PANEL_HEIGHT, bounds.height - y);
  return clampRect({ x: right - DEFAULT_PANEL_WIDTH, y, width: DEFAULT_PANEL_WIDTH, height }, bounds, MIN_PANEL_SIZE);
}

/** A saved rectangle, or null for anything that is not one: absent, not JSON, or a field missing or not finite. */
export function parseSavedGeometry(raw: string | null): Rect | null {
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { x, y, width, height } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/** The saved rectangle, as saved: the caller clamps it to the player. Null when storage throws or is absent. */
export function loadGeometry(storage: StorageLike | null | undefined): Rect | null {
  try {
    return parseSavedGeometry(storage?.getItem(GEOMETRY_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Saves the rectangle, and gives up silently where storage is blocked or full. */
export function saveGeometry(storage: StorageLike | null | undefined, rect: Rect): void {
  try {
    storage?.setItem(
      GEOMETRY_STORAGE_KEY,
      JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
    );
  } catch {
    // Private mode, blocked storage or a full quota: the geometry is simply not remembered.
  }
}

/** The cursor that shows which way an edge or corner resizes. */
export function cursorFor(edge: ResizeEdge): 'ns-resize' | 'ew-resize' | 'nwse-resize' | 'nesw-resize' {
  switch (edge) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
  }
}
