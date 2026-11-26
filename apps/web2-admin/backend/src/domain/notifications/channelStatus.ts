import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationChannelStatus,
} from '@streaming-monorepo/web2-admin-common';

import type { NotificationChannelRow, NotificationStore } from './NotificationStore.js';

/** What a channel's status is read from: the saved channels and how many notices wait for each. */
export type NotificationStatusSource = Pick<NotificationStore, 'channels' | 'waitingCounts'>;

/** How one channel stands, from its row, or as never saved and off without one. */
export function channelStatusOf(
  kind: NotificationChannelKind,
  row: NotificationChannelRow | undefined,
  waiting: number,
): NotificationChannelStatus {
  return {
    kind,
    saved: row !== undefined,
    enabled: row?.enabled ?? false,
    lastSentAt: row?.lastSentAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
    waiting: row ? waiting : 0,
  };
}

/**
 * Every channel's status, in the order of `NOTIFICATION_CHANNEL_KINDS`, saved or not: what the Auto top-up tab shows
 * of the channels, and what the Notifications page's view of each channel starts from.
 */
export async function notificationChannelStatuses(
  store: NotificationStatusSource,
): Promise<NotificationChannelStatus[]> {
  const [rows, counts] = await Promise.all([store.channels(), store.waitingCounts()]);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return NOTIFICATION_CHANNEL_KINDS.map((kind) => channelStatusOf(kind, byKind.get(kind), counts.get(kind) ?? 0));
}
