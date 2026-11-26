import type {
  MyDestination,
  NoticeServiceKind,
  NoticeServiceStatus,
  NoticeServiceView,
  NoticesView,
} from '@streaming-monorepo/web2-admin-common';

/**
 * The sentences the Notifications page and the Auto top-up tab share about the notices: how many people get one,
 * how a service stands, and how a destination's notices went. `docs/architecture/notifications.md`.
 */

/** `1 notice`, `2 notices`. */
export function noticeCount(count: number): string {
  return count === 1 ? '1 notice' : `${count} notices`;
}

/** How many people get a topic, beside its tick: "3 people get it", or "Nobody gets it". */
export function reachText(people: number): string {
  if (people === 0) return 'Nobody gets it';
  return people === 1 ? '1 person gets it' : `${people} people get it`;
}

/** Whether a service is set up and on, in a few words: "on", "set up, switched off" or "not set up". */
export function serviceSetUpText(service: Pick<NoticeServiceStatus, 'saved' | 'enabled'>): string {
  if (!service.saved) return 'not set up';
  return service.enabled ? 'on' : 'set up, switched off';
}

/**
 * How many destinations on a service are on and how many of those failed their last notice, counts alone: "3
 * destinations on it are on, and 1 of them failed its last notice."
 */
export function destinationsText(service: Pick<NoticeServiceStatus, 'people' | 'failing'>): string {
  const { people, failing } = service;
  if (people === 0) return 'No destination on it is on.';
  const on = people === 1 ? '1 destination on it is on' : `${people} destinations on it are on`;
  if (failing === 0) return `${on}.`;
  return `${on}, and ${failing} of them failed ${failing === 1 ? 'its' : 'their'} last notice.`;
}

/** The service a destination is on, out of the view. */
export function serviceOf(view: Pick<NoticesView, 'services'>, kind: NoticeServiceKind): NoticeServiceView | null {
  return view.services.find((service) => service.kind === kind) ?? null;
}

/** What a destination is called in a sentence of its own user's: "your email address", "your Telegram chat". */
export function yourDestination(kind: NoticeServiceKind): string {
  return kind === 'email' ? 'your email address' : 'your Telegram chat';
}

/**
 * Whether a notice can reach the user: a destination of theirs is saved and on, on a service that is saved and on.
 * A topic they ticked reaches them only then.
 */
export function noticesReachMe(view: Pick<NoticesView, 'services' | 'destinations'>): boolean {
  return view.destinations.some((destination: MyDestination) => {
    const service = serviceOf(view, destination.kind);
    return destination.address !== null && destination.enabled && service !== null && service.saved && service.enabled;
  });
}
