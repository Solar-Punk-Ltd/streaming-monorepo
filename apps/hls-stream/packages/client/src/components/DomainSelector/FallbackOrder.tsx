import { canMoveFallback, moveFallback } from '@/swarm/fallbackOrder';

interface FallbackOrderProps {
  /** The order the fallbacks are asked in, the default gateway last. */
  readonly order: readonly string[];
  readonly nameOf: (id: string) => string;
  readonly onChange: (order: readonly string[]) => void;
}

/**
 * The one order of fallbacks every part shares, a line saying it and, when there is more than the
 * default gateway to order, a button up and a button down per gateway. The default gateway is pinned
 * last, so it has neither.
 */
export function FallbackOrder({ order, nameOf, onChange }: FallbackOrderProps) {
  const move = (id: string, by: -1 | 1) => onChange(moveFallback(order, id, by));
  return (
    <section aria-label="Fallback">
      <h4 className="gateway-tools-title">Fallback</h4>
      <p className="gateway-tools-note">
        {order.length === 0 ? 'Off.' : `Asked in this order when a source fails: ${order.map(nameOf).join(', then ')}.`}
      </p>
      {order.length > 2 && (
        <ol className="gateway-tools-list" aria-label="Fallback order">
          {order.map((id, at) => {
            const name = nameOf(id);
            return (
              <li key={id} className="gateway-tools-row gateway-tools-row-heading">
                <span className="gateway-tools-name">{name}</span>
                <span className="gateway-tools-where">{at === order.length - 1 && 'always last'}</span>
                {canMoveFallback(order, id, -1) && (
                  <button className="gateway-tools-button" aria-label={`Move ${name} up`} onClick={() => move(id, -1)}>
                    Up
                  </button>
                )}
                {canMoveFallback(order, id, 1) && (
                  <button className="gateway-tools-button" aria-label={`Move ${name} down`} onClick={() => move(id, 1)}>
                    Down
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
