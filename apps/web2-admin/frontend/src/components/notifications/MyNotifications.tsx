import { Stack, Typography } from '@mui/material';
import type { NoticeServiceKind, NoticesView } from '@streaming-monorepo/web2-admin-common';

import { DestinationCard } from './DestinationCard';
import { serviceOf } from './noticeText';
import { TopicsCard } from './TopicsCard';

/**
 * The second part of the Notifications page, every signed-in user's own: their email address and their Telegram chat,
 * a card each, and the notices they get. The API reads and writes them by the session's own user, and answers them to
 * that user alone.
 */
export function MyNotifications({
  view,
  drafts,
  onDraft,
  onView,
  onReload,
}: {
  view: NoticesView;
  drafts: Partial<Record<NoticeServiceKind, string | null>>;
  onDraft: (kind: NoticeServiceKind, next: string | null) => void;
  onView: (next: NoticesView) => void;
  onReload: () => void;
}) {
  return (
    <Stack component="section" aria-labelledby="notifications-mine-title" spacing={2}>
      <Typography id="notifications-mine-title" variant="h6" component="h2">
        My notifications
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Where your own notices go, and which ones you get. What you save here is yours: no other user sees it.
      </Typography>
      {view.destinations.map((destination) => (
        <DestinationCard
          key={destination.kind}
          destination={destination}
          service={serviceOf(view, destination.kind)}
          available={view.available}
          draft={drafts[destination.kind] ?? null}
          onDraft={(next) => onDraft(destination.kind, next)}
          onView={onView}
          onReload={onReload}
        />
      ))}
      <TopicsCard view={view} onView={onView} />
    </Stack>
  );
}
