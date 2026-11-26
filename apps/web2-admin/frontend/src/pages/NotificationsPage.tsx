import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import type { NotificationChannelKind, NotificationsView } from '@streaming-monorepo/web2-admin-common';

import * as api from '../api';
import { ChannelCard } from '../components/notifications/ChannelCard';
import type { ChannelDraft } from '../components/notifications/channelDraft';
import { errorMessage, NOTIFICATIONS_UNAVAILABLE } from '../errors';

/**
 * Reads `GET /api/notifications` when the page mounts, and again on `load`. Only the latest read is answered, and a
 * write's answer, the whole view, replaces the view.
 */
function useNotifications() {
  const [view, setView] = useState<NotificationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);

  const load = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    setError(null);
    api
      .fetchNotifications()
      .then((next) => {
        if (read === reads.current) setView(next);
      })
      .catch((e: unknown) => {
        if (read === reads.current) setError(errorMessage(e, 'The view could not be read.'));
      });
  }, []);

  useEffect(load, [load]);

  const take = useCallback((next: NotificationsView) => {
    reads.current += 1;
    setError(null);
    setView(next);
  }, []);

  return { view, error, load, setView: take };
}

/**
 * Notifications: the channels the admin's notices go out on, email by Brevo, Slack and Telegram, one card each. A
 * card shows how its channel stands and holds its form: saving asks for the password, since a changed channel
 * changes where the alerts go; switching it on or off, testing it and removing it do not. The secrets are write-only.
 * With the admin's `BRAND_WALLET_SECRET` unset, the page says no channel can be saved. `docs/architecture/notifications.md`.
 */
export function NotificationsPage() {
  const { view, error, load, setView } = useNotifications();
  const [drafts, setDrafts] = useState<Partial<Record<NotificationChannelKind, ChannelDraft | null>>>({});

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Notifications
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        The alerts and warnings of stamp auto top-up go out on every channel that is on. With none on, they show on the
        Funding page&apos;s Auto top-up tab alone.
      </Typography>
      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {`The notification channels could not be read: ${error}`}
        </Alert>
      ) : null}
      {view && !view.available ? <Alert severity="warning">{NOTIFICATIONS_UNAVAILABLE}</Alert> : null}
      {view?.channels.map((channel) => (
        <ChannelCard
          key={channel.kind}
          channel={channel}
          available={view.available}
          draft={drafts[channel.kind] ?? null}
          onDraft={(next) => setDrafts((current) => ({ ...current, [channel.kind]: next }))}
          onView={setView}
          onReload={load}
        />
      ))}
    </Stack>
  );
}
