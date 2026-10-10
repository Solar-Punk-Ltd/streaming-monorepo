import { useEffect, useState } from 'react';

import { useAppContext } from '@/providers/App';
import { ROUTING_MODES, type RoutingMode, setMode } from '@/swarm/routing';
import { sourceName } from '@/swarm/sources';

import { GatewayTools } from './GatewayTools';
import { PartRoutes } from './PartRoutes';
import { isServingFromFallback } from './providerStatus';

import './DomainSelector.scss';

const KEY_ESCAPE = 'Escape';

const MODE_LABELS: Readonly<Record<RoutingMode, string>> = { one: 'One source', 'per-part': 'Per part' };

/** How often the button reads the client's counts again for its fallback marker. */
const MARKER_REFRESH_MS = 2_000;

/**
 * The picker a viewer uses to choose where the video, the stream list and the previews load from: the
 * build's gateways and any gateways and Bee nodes of their own, one source for everything or one per
 * part, and the order the fallbacks are asked in. Every change applies at once and is remembered in
 * this browser.
 *
 * A source is added only once its address has answered a check, so a typo, or a node that refuses this
 * site's origin, is reported here in words rather than reaching the viewer later as a catalog with
 * nothing in it. The build's default gateway is always in the list, one click away, because a viewer
 * who tried their own node and gave up has no other route back.
 *
 * The list, its checks and the debug tools are {@link GatewayTools}.
 */
export function DomainSelector() {
  const { sources, routing, parts, setRouting, swarm } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [, setRefreshes] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setRefreshes((count) => count + 1), MARKER_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const close = () => setIsOpen(false);
  const current = routing.mode === 'per-part' ? MODE_LABELS['per-part'] : sourceName(sources, parts.player);

  return (
    <>
      <button className="gateway-button" onClick={() => setIsOpen(true)} title="Choose where streams load from">
        <span className="gateway-button-label">Sources</span>
        <span className="gateway-button-current">{current}</span>
        {isServingFromFallback(swarm.activity(), swarm.health()) && (
          <span className="gateway-button-marker">Using fallback</span>
        )}
      </button>

      {isOpen && (
        <div className="gateway-modal-backdrop" onClick={close}>
          <div
            className="gateway-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === KEY_ESCAPE) {
                close();
              }
            }}
          >
            <h3 className="gateway-modal-title">Sources</h3>
            <p className="gateway-modal-description">
              Streams normally load through this site&apos;s gateway. Pick another gateway, or a Bee node of your own
              such as Swarm Desktop, for everything or for each part. Changes apply at once and are remembered in this
              browser.
            </p>
            <div className="gateway-modes" role="radiogroup" aria-label="Routing">
              {ROUTING_MODES.map((mode) => (
                <label key={mode} className="gateway-mode">
                  <input
                    type="radio"
                    aria-label={MODE_LABELS[mode]}
                    checked={routing.mode === mode}
                    onChange={() => setRouting(setMode(routing, mode))}
                  />{' '}
                  {MODE_LABELS[mode]}
                </label>
              ))}
            </div>
            {routing.mode === 'per-part' && (
              <PartRoutes sources={sources} routing={routing} parts={parts} onChange={setRouting} />
            )}
            <GatewayTools />
            <div className="gateway-modal-actions">
              <span className="gateway-modal-actions-spacer" />
              <button className="gateway-modal-cancel" onClick={close}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
