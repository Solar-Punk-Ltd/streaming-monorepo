import { useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import type { NoticeServiceKind } from '@streaming-monorepo/web2-admin-common';

import { MyNotifications } from '../components/notifications/MyNotifications';
import type { ServiceDraft } from '../components/notifications/serviceDraft';
import { SharedServices } from '../components/notifications/SharedServices';
import { useNotices } from '../components/notifications/useNotices';
import { NOTIFICATIONS_UNAVAILABLE } from '../errors';

/**
 * Notifications, in two parts. Shared services: the email service and the Telegram bot every user's notices go out
 * through, which a user with the admin role saves behind the password, switches and removes, and of which every other
 * user sees whether each is set up and on. My notifications: the signed-in user's own email address and Telegram chat,
 * saved behind their password, with Find my chat and a test notice each, and the notices they get, ticked with no
 * password. The secrets are write-only, and of the other users the page shows numbers alone. With the admin's
 * `BRAND_WALLET_SECRET` unset, the page says no service can be saved and no notice sent.
 * `docs/architecture/notifications.md`.
 */
export function NotificationsPage() {
  const { view, error, load, setView } = useNotices();
  const [serviceDrafts, setServiceDrafts] = useState<Partial<Record<NoticeServiceKind, ServiceDraft | null>>>({});
  const [destinationDrafts, setDestinationDrafts] = useState<Partial<Record<NoticeServiceKind, string | null>>>({});

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        Notifications
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        The alerts and warnings of stamp auto top-up go to each user&apos;s own email address and Telegram chat, for the
        notices they tick. A notice nobody gets shows on the Funding page&apos;s Auto top-up tab alone.
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
          {`The notifications could not be read: ${error}`}
        </Alert>
      ) : null}
      {view && !view.available ? <Alert severity="warning">{NOTIFICATIONS_UNAVAILABLE}</Alert> : null}
      {view ? (
        <>
          <SharedServices
            view={view}
            drafts={serviceDrafts}
            onDraft={(kind, next) => setServiceDrafts((current) => ({ ...current, [kind]: next }))}
            onView={setView}
            onReload={load}
          />
          <MyNotifications
            view={view}
            drafts={destinationDrafts}
            onDraft={(kind, next) => setDestinationDrafts((current) => ({ ...current, [kind]: next }))}
            onView={setView}
            onReload={load}
          />
        </>
      ) : null}
    </Stack>
  );
}
