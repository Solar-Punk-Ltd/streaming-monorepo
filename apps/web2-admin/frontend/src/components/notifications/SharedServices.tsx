import { Stack, Typography } from '@mui/material';
import { NOTICE_SERVICE_NAMES, type NoticeServiceKind, type NoticesView } from '@streaming-monorepo/web2-admin-common';

import { serviceSetUpText } from './noticeText';
import { ServiceCard } from './ServiceCard';
import type { ServiceDraft } from './serviceDraft';

/**
 * The first part of the Notifications page: the services every user's notices go out through, email and Telegram. A
 * user with the admin role (`managesServices`) has a card for each, to save, switch and remove it. Every other user
 * sees of each service whether it is set up and on, and nothing more.
 */
export function SharedServices({
  view,
  drafts,
  onDraft,
  onView,
  onReload,
}: {
  view: NoticesView;
  drafts: Partial<Record<NoticeServiceKind, ServiceDraft | null>>;
  onDraft: (kind: NoticeServiceKind, next: ServiceDraft | null) => void;
  onView: (next: NoticesView) => void;
  onReload: () => void;
}) {
  return (
    <Stack component="section" aria-labelledby="notifications-services-title" spacing={2}>
      <Typography id="notifications-services-title" variant="h6" component="h2">
        Shared services
      </Typography>
      {view.managesServices ? (
        <>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Every user&apos;s notices go out through these services. As an admin you set them up here; each user then
            enters their own email address and Telegram chat under My notifications.
          </Typography>
          {view.services.map((service) => (
            <ServiceCard
              key={service.kind}
              service={service}
              available={view.available}
              draft={drafts[service.kind] ?? null}
              onDraft={(next) => onDraft(service.kind, next)}
              onView={onView}
              onReload={onReload}
            />
          ))}
        </>
      ) : (
        <Stack spacing={0.5}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Every user&apos;s notices go out through these services, which an admin sets up.
          </Typography>
          {view.services.map((service) => (
            <Typography key={service.kind} variant="body2" data-service={service.kind}>
              {`${NOTICE_SERVICE_NAMES[service.kind]}: ${serviceSetUpText(service)}.`}
            </Typography>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
