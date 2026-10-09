import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BarChartIcon } from '@/components/Icons/BarChartIcon';
import { MoveIcon } from '@/components/Icons/MoveIcon';
import { config } from '@/utils/config';
import type { PlayerRelease } from '@/utils/playerRelease';

import {
  type Bounds,
  buttonOf,
  clampRect,
  cursorFor,
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  defaultRect,
  loadGeometry,
  MIN_PANEL_SIZE,
  moveHiddenRect,
  moveRect,
  panelAtButton,
  reclampRect,
  RESIZE_EDGES,
  type Rect,
  type ResizeEdge,
  resizeRect,
  saveGeometry,
  type StorageLike,
  usableBounds,
} from './qoeGeometry';
import { QoePanel } from './QoePanel';
import { QoeMetrics } from './useHlsQoeMetrics';

import './QoeOverlay.scss';

/** This browser's localStorage, or null where there is none (SSR, node tests) or touching it throws (blocked storage). */
function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The player's size: the padding box of the overlay's offsetParent, which its left and top are
 * relative to. Null when there is none, or it measures nothing on a side (hidden, display:none, not
 * laid out yet): every reader then leaves the geometry as it is.
 */
function playerBounds(overlay: HTMLElement | null): Bounds | null {
  const parent = overlay?.offsetParent;
  const bounds = parent ? { width: parent.clientWidth, height: parent.clientHeight } : null;
  return usableBounds(bounds) ? bounds : null;
}

/** The saved geometry pulled back inside the player, or the default. */
function initialRect(bounds: Bounds): Rect {
  const saved = loadGeometry(browserStorage());
  return saved ? clampRect(saved, bounds, MIN_PANEL_SIZE) : defaultRect(bounds);
}

const sameRect = (a: Rect | null, b: Rect) =>
  a != null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

interface QoeOverlayProps {
  metrics: QoeMetrics;
  /**
   * The release the player was built as, shown under the panel's header, and nowhere else in the
   * player. Left out, the one the bundle was built with. Null, or a bundle built with none, shows no
   * release line at all.
   */
  release?: PlayerRelease | null;
  /** The stream's topic, which names the file the panel's Save writes. */
  topic?: string;
}

/**
 * The toggle button and, below it, the metrics panel, which resizes from every edge and corner like
 * a desktop window. All of the geometry, one panel rectangle in the player's coordinates with the
 * button on its top-right corner, is in qoeGeometry.ts; this component only feeds it pointer deltas
 * and the player's size, and remembers the result in this browser.
 */
export const QoeOverlay: React.FC<QoeOverlayProps> = ({ metrics, release = config.release, topic }) => {
  const [visible, setVisible] = useState(true);
  // Null until the player has been measured, which a server render never does.
  const [rect, setRectState] = useState<Rect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [resizing, setResizing] = useState<ResizeEdge | null>(null);

  // The latest rectangle and visibility, for the handlers and observers that outlive a render. While
  // the panel is hidden the rectangle keeps its size and the button still derives from it, but only
  // the button is kept inside the player (see qoeGeometry.ts).
  const rectRef = useRef<Rect | null>(null);
  const visibleRef = useRef(true);
  const drag = useRef<{ startX: number; startY: number; start: Rect; bounds: Bounds } | null>(null);
  const didDrag = useRef(false);
  const resize = useRef<{
    pointerId: number;
    edge: ResizeEdge;
    startX: number;
    startY: number;
    start: Rect;
    bounds: Bounds;
  } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const setRect = useCallback((next: Rect) => {
    if (sameRect(rectRef.current, next)) {
      return;
    }
    rectRef.current = next;
    setRectState(next);
  }, []);

  // Before the first paint: the saved geometry pulled back inside the player, or the default. A player
  // not laid out yet gets it from the first reading of its size that is usable, below.
  useLayoutEffect(() => {
    const bounds = playerBounds(overlayRef.current);
    if (bounds) {
      setRect(initialRect(bounds));
    }
  }, [setRect]);

  // The player resizes (a window resize, the page's layout): clamp again into its new bounds. Not
  // saved, so a brief resize does not overwrite what the viewer chose. The video's native fullscreen
  // shows the video alone, so it neither shows the overlay nor resizes the player. A reading of 0 on
  // a side is skipped and the geometry left as it was.
  useEffect(() => {
    const parent = overlayRef.current?.offsetParent;
    if (!parent) {
      return;
    }
    const reclamp = () => {
      const bounds = playerBounds(overlayRef.current);
      if (bounds) {
        const current = rectRef.current;
        setRect(current ? reclampRect(current, bounds, visibleRef.current) : initialRect(bounds));
      }
    };
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(reclamp);
      observer.observe(parent);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [setRect]);

  // Hiding the panel unmounts its handles, so a resize under way ends with it. Showing it hangs it at
  // the button's corner with its last size and pulls the pair back inside the player.
  const toggle = useCallback(() => {
    resize.current = null;
    setResizing(null);
    const opening = !visibleRef.current;
    visibleRef.current = opening;
    setVisible(opening);
    const bounds = playerBounds(overlayRef.current);
    const current = rectRef.current;
    if (opening && bounds && current) {
      setRect(panelAtButton(buttonOf(current), current, bounds, MIN_PANEL_SIZE));
    }
  }, [setRect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'q' || e.key === 'Q') {
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // Dragging the button moves the button and the panel together; with the panel hidden, the button alone.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) {
        return;
      }

      didDrag.current = true;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setRect(visibleRef.current ? moveRect(d.start, dx, dy, d.bounds) : moveHiddenRect(d.start, dx, dy, d.bounds));
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) {
        return;
      }

      drag.current = null;
      setIsDragging(false);
      const current = rectRef.current;
      if (didDrag.current && current) {
        // Hidden, what is saved is where the panel will open, so a reload with it open agrees.
        saveGeometry(
          browserStorage(),
          visibleRef.current ? current : panelAtButton(buttonOf(current), current, d.bounds, MIN_PANEL_SIZE),
        );
      }
      setTimeout(() => {
        didDrag.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setRect]);

  // No text selection anywhere on the page while the button or an edge is being dragged, and the
  // edge's cursor even where the pointer runs ahead of the handle. Restored at the end, and on unmount.
  useEffect(() => {
    if (!isDragging && !resizing) {
      return;
    }
    const { style } = document.body;
    const before = { userSelect: style.userSelect, cursor: style.cursor };
    style.userSelect = 'none';
    if (resizing) {
      style.cursor = cursorFor(resizing);
    }
    return () => {
      style.userSelect = before.userSelect;
      style.cursor = before.cursor;
    };
  }, [isDragging, resizing]);

  const onMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    const bounds = playerBounds(overlayRef.current);
    const start = rectRef.current;
    if (!bounds || !start) {
      return;
    }

    drag.current = { startX: e.clientX, startY: e.clientY, start, bounds };
    didDrag.current = false;
    setIsDragging(true);

    e.preventDefault();
  };

  const handleClick = () => {
    if (!didDrag.current) {
      toggle();
    }
  };

  const onResizeStart = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    const bounds = playerBounds(overlayRef.current);
    const start = rectRef.current;
    if (e.button !== 0 || !bounds || !start) {
      return;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; the move and up events still arrive while it is over the handle.
    }
    resize.current = { pointerId: e.pointerId, edge, startX: e.clientX, startY: e.clientY, start, bounds };
    setResizing(edge);
    e.preventDefault();
    e.stopPropagation();
  };

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resize.current;
    if (!r || r.pointerId !== e.pointerId) {
      return;
    }
    setRect(resizeRect(r.start, r.edge, e.clientX - r.startX, e.clientY - r.startY, r.bounds, MIN_PANEL_SIZE));
  };

  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resize.current;
    if (!r || r.pointerId !== e.pointerId) {
      return;
    }
    resize.current = null;
    setResizing(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (rectRef.current) {
      saveGeometry(browserStorage(), rectRef.current);
    }
  };

  // The overlay element is the button's box; the panel's frame hangs below it, right edges aligned.
  const button = rect ? buttonOf(rect) : null;
  const floatStyle: React.CSSProperties | undefined = button
    ? { left: button.x, top: button.y, right: 'auto' }
    : undefined;
  const frameStyle: React.CSSProperties = {
    width: rect?.width ?? DEFAULT_PANEL_WIDTH,
    height: rect?.height ?? DEFAULT_PANEL_HEIGHT,
  };

  return (
    <div ref={overlayRef} className="qoe-overlay" style={floatStyle}>
      <button
        type="button"
        className={['qoe-btn', visible ? 'qoe-btn--active' : '', isDragging ? 'qoe-btn--dragging' : '']
          .filter(Boolean)
          .join(' ')}
        onMouseDown={onMouseDown}
        onClick={handleClick}
        title="Toggle metrics (Q) · Drag to reposition"
        aria-label={visible ? 'Hide QoE metrics' : 'Show QoE metrics'}
        aria-pressed={visible}
      >
        <span className="qoe-btn__chart">
          <BarChartIcon />
        </span>
        <span className="qoe-btn__move">
          <MoveIcon />
        </span>
        {visible && <span className="qoe-btn__live" />}
      </button>

      {visible && (
        <div className="qoe-overlay__frame" style={frameStyle}>
          {RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              className={`qoe-overlay__handle qoe-overlay__handle--${edge}`}
              style={{ cursor: cursorFor(edge) }}
              aria-hidden="true"
              onPointerDown={onResizeStart(edge)}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onLostPointerCapture={onResizeEnd}
            />
          ))}
          <QoePanel metrics={metrics} release={release} topic={topic} />
        </div>
      )}
    </div>
  );
};
