/**
 * The one order of fallbacks every part shares (decision 48). The deployment sets the default order,
 * the viewer may keep their own in the browser, and the event gateway, the deployment's default, is
 * always last, so whatever else fails the event's own gateway is still asked. Pure.
 */
import type { SwarmSettings } from './settings';

/**
 * The order the client asks, from what the viewer saved: the gateways the deployment falls back to,
 * in the viewer's order where they gave one and in the deployment's where they did not, the event
 * gateway last. An id the deployment no longer falls back to is dropped, so a saved order can reorder
 * the fallbacks and never add one.
 */
export function fallbackOrderFor(settings: SwarmSettings, saved: readonly string[] | null): string[] {
  const built = settings.fallbackOrder;
  if (built.length === 0) {
    return [];
  }
  const pinned = built[built.length - 1];
  const movable = built.slice(0, -1);
  const kept = [...new Set((saved ?? []).filter((id) => movable.includes(id)))];
  return [...kept, ...movable.filter((id) => !kept.includes(id)), pinned];
}

/** Whether a fallback can move one place up (-1) or down (1). The last, the event gateway, stays where it is. */
export function canMoveFallback(order: readonly string[], id: string, by: -1 | 1): boolean {
  const at = order.indexOf(id);
  const pinnedAt = order.length - 1;
  return at !== -1 && at !== pinnedAt && at + by >= 0 && at + by < pinnedAt;
}

export function moveFallback(order: readonly string[], id: string, by: -1 | 1): string[] {
  if (!canMoveFallback(order, id, by)) {
    return [...order];
  }
  const moved = [...order];
  const at = moved.indexOf(id);
  [moved[at], moved[at + by]] = [moved[at + by], moved[at]];
  return moved;
}

export function serializeFallbackOrder(order: readonly string[]): string {
  return JSON.stringify(order);
}

/** The order a browser kept, its ids only, or null when it kept none it can read. */
export function parseFallbackOrder(saved: string | null): string[] | null {
  if (saved === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
}
