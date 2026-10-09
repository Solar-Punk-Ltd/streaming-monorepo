import React, { useEffect, useRef, useState } from 'react';

import { BarChartIcon } from '@/components/Icons/BarChartIcon';
import { MoveIcon } from '@/components/Icons/MoveIcon';
import { config } from '@/utils/config';
import type { PlayerRelease } from '@/utils/playerRelease';

import { QoePanel } from './QoePanel';
import { QoeMetrics } from './useHlsQoeMetrics';

import './QoeOverlay.scss';

const DEFAULT_OVERLAY_X_OFFSET = 50;
const DEFAULT_OVERLAY_Y_OFFSET = 10;

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

export const QoeOverlay: React.FC<QoeOverlayProps> = ({ metrics, release = config.release, topic }) => {
  const [visible, setVisible] = useState(true);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dragging = useRef(false);
  const didDrag = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parentBoundingRect = overlayRef.current?.offsetParent?.getBoundingClientRect();
    if (!parentBoundingRect) {
      return;
    }
    setPos({
      x: parentBoundingRect.width - DEFAULT_OVERLAY_X_OFFSET,
      y: DEFAULT_OVERLAY_Y_OFFSET,
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'q' || e.key === 'Q') {
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !overlayRef.current) {
        return;
      }

      didDrag.current = true;
      const pr = overlayRef.current.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
      setPos({
        x: e.clientX - dragOffset.current.x - pr.left,
        y: e.clientY - dragOffset.current.y - pr.top,
      });
    };
    const onUp = () => {
      if (!dragging.current) {
        return;
      }

      dragging.current = false;
      setIsDragging(false);
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
  }, []);

  const onMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!overlayRef.current) {
      return;
    }

    const overlayBoundingRect = overlayRef.current.getBoundingClientRect();
    const parentBoundingRect = overlayRef.current.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };

    dragging.current = true;
    didDrag.current = false;
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - overlayBoundingRect.left, y: e.clientY - overlayBoundingRect.top };
    setPos({
      x: overlayBoundingRect.left - parentBoundingRect.left,
      y: overlayBoundingRect.top - parentBoundingRect.top,
    });

    e.preventDefault();
  };

  const handleClick = () => {
    if (!didDrag.current) {
      setVisible((v) => !v);
    }
  };

  const floatStyle: React.CSSProperties | undefined = pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined;

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

      {visible && <QoePanel metrics={metrics} release={release} topic={topic} />}
    </div>
  );
};
