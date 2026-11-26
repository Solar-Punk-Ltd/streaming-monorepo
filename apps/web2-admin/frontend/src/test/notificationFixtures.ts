import {
  NOTICE_TOPICS,
  type MyDestination,
  type NoticeServiceKind,
  type NoticeServiceView,
  type NoticesView,
  type NoticeTopic,
  type NoticeTopicReach,
} from '@streaming-monorepo/web2-admin-common';

/** A service never saved: off, with no settings, nothing sent, nobody on it and nothing waiting. */
export function unsavedService(kind: NoticeServiceKind): NoticeServiceView {
  return {
    kind,
    saved: false,
    enabled: false,
    lastSentAt: null,
    lastFailure: null,
    lastFailureAt: null,
    people: 0,
    failing: 0,
    waiting: 0,
    settings: null,
    savedBy: null,
    savedAt: null,
  } as NoticeServiceView;
}

/** The email service saved by an operator and on, sending through Brevo, as an admin reads it. */
export function savedEmailService(over: Partial<NoticeServiceView> = {}): NoticeServiceView {
  return {
    ...unsavedService('email'),
    saved: true,
    enabled: true,
    settings: { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: 'Stream Admin' },
    savedBy: 'operator',
    savedAt: '2026-10-04T08:00:00.000Z',
    ...over,
  } as NoticeServiceView;
}

/** The Telegram service saved by an operator and on, as an admin reads it: its settings are none. */
export function savedTelegramService(over: Partial<NoticeServiceView> = {}): NoticeServiceView {
  return {
    ...unsavedService('telegram'),
    saved: true,
    enabled: true,
    settings: {},
    savedBy: 'operator',
    savedAt: '2026-10-04T08:00:00.000Z',
    ...over,
  } as NoticeServiceView;
}

/** A destination of mine never saved: no address, off, nothing sent and no test. */
export function unsavedDestination(kind: NoticeServiceKind): MyDestination {
  return {
    kind,
    address: null,
    enabled: false,
    savedAt: null,
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    waiting: 0,
    lastTestAt: null,
    lastTestError: null,
  };
}

/** My email address, saved and on. */
export function savedEmailDestination(over: Partial<MyDestination> = {}): MyDestination {
  return {
    ...unsavedDestination('email'),
    address: 'me@example.org',
    enabled: true,
    savedAt: '2026-10-04T09:00:00.000Z',
    ...over,
  };
}

/** My Telegram chat, my own chat with the bot, saved and on. */
export function savedTelegramDestination(over: Partial<MyDestination> = {}): MyDestination {
  return {
    ...unsavedDestination('telegram'),
    address: '123456789',
    enabled: true,
    savedAt: '2026-10-04T09:00:00.000Z',
    ...over,
  };
}

/** How many people get each topic: the ones given, and nobody for the rest, in the order of `NOTICE_TOPICS`. */
export function reachOf(people: Partial<Record<NoticeTopic, number>> = {}): NoticeTopicReach[] {
  return NOTICE_TOPICS.map((topic) => ({ topic, people: people[topic] ?? 0 }));
}

/**
 * The Notifications page's view for an admin: services can be saved, neither is saved, I saved no destination and
 * ticked no topic, and nobody gets any. `services` and `destinations` take one of each kind, by kind.
 */
export function makeNoticesView(
  over: Partial<Omit<NoticesView, 'services' | 'destinations'>> & {
    services?: Partial<Record<NoticeServiceKind, NoticeServiceView>>;
    destinations?: Partial<Record<NoticeServiceKind, MyDestination>>;
  } = {},
): NoticesView {
  const { services = {}, destinations = {}, ...rest } = over;
  return {
    available: true,
    managesServices: true,
    topics: [],
    reach: reachOf(),
    ...rest,
    services: [services.email ?? unsavedService('email'), services.telegram ?? unsavedService('telegram')],
    destinations: [
      destinations.email ?? unsavedDestination('email'),
      destinations.telegram ?? unsavedDestination('telegram'),
    ],
  };
}
