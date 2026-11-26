/**
 * The admin's notices to people: the topics a person picks from, the services everyone shares, each user's own
 * destinations, and what the Notifications page and the Funding page's Auto top-up tab show of them.
 * `docs/architecture/notifications.md` is the design.
 *
 * The services, the destinations and the checks of both are the shared notifications package's, re-exported here, so
 * the console's forms and the API refuse the same values. What is written here is the admin's own: its topics, its
 * routes and what they answer. Every moment on the wire is ISO 8601.
 */

import type {
  NoticeServiceKind,
  NoticeServiceSettingsByKind,
  TelegramBot,
  TelegramChat,
} from '@streaming-monorepo/notifications/rules';

export * from '@streaming-monorepo/notifications/rules';

// ---------------------------------------------------------------- the topics

/**
 * What a notice can be about, as a person picks what reaches them. A sender hands its notice over in parts, each under
 * one topic, and a person gets the parts of the topics they ticked.
 *
 * - `topups_coming`: top-ups of marked stamps are coming up.
 * - `wallet_low`: the brand wallet is low on xBZZ or on xDAI.
 * - `topup_failed`: a due marked stamp could not be topped up.
 * - `stamp_expired`: a marked stamp expired.
 * - `unmarked_catalogue`: the catalogue batch or an archive stamp that is not marked for auto top-up is running low.
 * - `unmarked_stage`: a stage's batch that is not marked for auto top-up is running low.
 */
export const NOTICE_TOPICS = [
  'topups_coming',
  'wallet_low',
  'topup_failed',
  'stamp_expired',
  'unmarked_catalogue',
  'unmarked_stage',
] as const;
export type NoticeTopic = (typeof NOTICE_TOPICS)[number];

export function isNoticeTopic(value: unknown): value is NoticeTopic {
  return (NOTICE_TOPICS as readonly unknown[]).includes(value);
}

/** What a view calls each topic, beside its tick. */
export const NOTICE_TOPIC_NAMES: Readonly<Record<NoticeTopic, string>> = {
  topups_coming: 'Top-ups coming up',
  wallet_low: 'The brand wallet is low',
  topup_failed: 'A top-up failed',
  stamp_expired: 'A marked stamp expired',
  unmarked_catalogue: 'Catalogue and archive stamps',
  unmarked_stage: 'Stage stamps',
};

/** The topics as a view lists them: under the name of what sends them, in the order of {@link NOTICE_TOPICS}. */
export const NOTICE_TOPIC_GROUPS: readonly { name: string; topics: readonly NoticeTopic[] }[] = [
  { name: 'Stamp auto top-up', topics: ['topups_coming', 'wallet_low', 'topup_failed', 'stamp_expired'] },
  { name: 'Stamps not on auto top-up', topics: ['unmarked_catalogue', 'unmarked_stage'] },
];

/**
 * The topics a user starts with, ticked when they save their first destination: the four of stamp auto top-up. The two
 * of the stamps not on auto top-up start unticked. A user who never saved a destination or a tick gets no notice.
 */
export const STARTING_NOTICE_TOPICS: readonly NoticeTopic[] = [
  'topups_coming',
  'wallet_low',
  'topup_failed',
  'stamp_expired',
];

/** Why this cannot be a user's topics, in a sentence, or null. It takes what a request's body holds, of any shape. */
export function noticeTopicsProblem(topics: unknown): string | null {
  if (!Array.isArray(topics) || topics.some((topic) => !isNoticeTopic(topic))) {
    return `The topics are a list of: ${NOTICE_TOPICS.join(', ')}.`;
  }
  return null;
}

/** The topics as they are kept and answered: each known one once, in the order of {@link NOTICE_TOPICS}. */
export function storedNoticeTopics(topics: readonly string[]): NoticeTopic[] {
  return NOTICE_TOPICS.filter((topic) => topics.includes(topic));
}

// ---------------------------------------------------------------- the routes

/** `GET`: the view of the Notifications page, which the Auto top-up tab reads as well. */
export const NOTIFICATIONS_PATH = '/api/notifications';

/**
 * `PUT`: save a service, behind the operator's password. `DELETE`: remove it, with its secret. Both are for a user
 * with the admin role, as the service's switch is.
 */
export function noticeServicePath(kind: NoticeServiceKind): string {
  return `${NOTIFICATIONS_PATH}/services/${kind}`;
}

/** `PUT`: switch a saved service on or off. */
export function noticeServiceEnabledPath(kind: NoticeServiceKind): string {
  return `${noticeServicePath(kind)}/enabled`;
}

/** Under it, every route reads and writes the signed-in user's own destinations and topics, and no other user's. */
export const MY_NOTIFICATIONS_PATH = `${NOTIFICATIONS_PATH}/me`;

/** `PUT`: save my destination on a service, behind my password. `DELETE`: remove it. */
export function myDestinationPath(kind: NoticeServiceKind): string {
  return `${MY_NOTIFICATIONS_PATH}/destinations/${kind}`;
}

/** `PUT`: switch my saved destination on or off. */
export function myDestinationEnabledPath(kind: NoticeServiceKind): string {
  return `${myDestinationPath(kind)}/enabled`;
}

/** `POST`: send me a test notice on my saved destination. */
export function myDestinationTestPath(kind: NoticeServiceKind): string {
  return `${myDestinationPath(kind)}/test`;
}

/** `PUT`: save the topics I get. */
export const MY_NOTICE_TOPICS_PATH = `${MY_NOTIFICATIONS_PATH}/topics`;

/** `POST`: start a code to send to the Telegram bot from my chat. */
export const MY_TELEGRAM_CODE_PATH = `${MY_NOTIFICATIONS_PATH}/telegram/code`;

/** `POST`: Find my chat, the one that sent my code to the bot. */
export const MY_TELEGRAM_CHAT_PATH = `${MY_NOTIFICATIONS_PATH}/telegram/chat`;

/** The least time between two test notices on one destination: a minute. */
export const NOTIFICATION_TEST_EVERY_SECONDS = 60;

/**
 * How long a notice waits for a destination that could not take it while another took what it tells of: a day from
 * when it was raised. After that it is dropped.
 */
export const NOTIFICATION_WAIT_SECONDS = 24 * 60 * 60;

/** How long a code to find one's Telegram chat holds: 10 minutes. A user has one at a time. */
export const TELEGRAM_CHAT_CODE_SECONDS = 600;

/** 409: the admin has no secret to seal a service's secret under, so no service can be saved and none sends. */
export const NOTIFICATIONS_UNAVAILABLE_ERROR = 'notifications_unavailable';

/** 409: the service named was never saved, so there is nothing to switch, and nothing a test or a code can go through. */
export const NOTICE_SERVICE_NOT_SAVED_ERROR = 'service_not_saved';

/** 409: the user has no destination saved on the service named, so there is nothing to switch or to test. */
export const NOTICE_DESTINATION_NOT_SAVED_ERROR = 'destination_not_saved';

/**
 * 429: a test notice went to this destination less than {@link NOTIFICATION_TEST_EVERY_SECONDS} ago. The answer
 * carries `retryAfterSeconds`.
 */
export const NOTIFICATION_TEST_TOO_SOON_ERROR = 'test_too_soon';

/** 409: Find my chat was asked with no code that holds: none was started, or the last one is over. */
export const TELEGRAM_CODE_NOT_STARTED_ERROR = 'code_not_started';

// -------------------------------------------------------------- the services

/**
 * `PUT /api/notifications/services/:kind`: save the service's settings and its secret. For a user with the admin role:
 * 403 `admin_required` for any other. Behind the operator's password as a send from the brand wallet is: 401
 * `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked out. The settings and the secret are
 * checked by `serviceSettingsProblems` and `serviceSecretProblem`: 400 `validation_error` with a sentence for each in
 * `errors`, as every refused request body answers.
 *
 * `secret` null keeps the stored secret, and is refused for a service that has none. A service saved for the first
 * time starts on, and a later save keeps its switch.
 */
export interface NoticeServiceSaveRequest<K extends NoticeServiceKind = NoticeServiceKind> {
  password: string;
  settings: NoticeServiceSettingsByKind[K];
  secret: string | null;
}

/**
 * `PUT /api/notifications/services/:kind/enabled`, for a user with the admin role, and
 * `PUT /api/notifications/me/destinations/:kind/enabled`, for the user whose destination it is: switch it on or off. A
 * session is enough.
 */
export interface NoticeEnabledRequest {
  enabled: boolean;
}

/**
 * How one service stands. The Auto top-up tab shows it to every user, and the Notifications page to a user with the
 * admin role; any other user reads there whether the service is set up and on.
 */
export interface NoticeServiceStatus {
  kind: NoticeServiceKind;
  /** Whether it was saved, with its settings and its secret. One never saved is off. */
  saved: boolean;
  /** Whether notices go out through it. */
  enabled: boolean;
  /** When it last took a notice, for any user, or null. A test notice does not count. */
  lastSentAt: string | null;
  /**
   * Why the latest send through it failed, in a sentence that names no user and no destination: the service's status,
   * or that no answer came. Null while none failed. It stays after a later send went out, so it is read beside
   * `lastSentAt`.
   */
  lastFailure: string | null;
  /** When that was, or null. */
  lastFailureAt: string | null;
  /** How many users have a destination on it that is on. */
  people: number;
  /** How many of those destinations could not take their last notice. */
  failing: number;
  /** How many notices wait for its destinations. */
  waiting: number;
}

/**
 * One service on the Notifications page: how it stands and, for a user with the admin role, its settings and who
 * saved it. Its secret is in no answer: `saved` says there is one.
 */
export type NoticeServiceView = {
  [K in NoticeServiceKind]: NoticeServiceStatus & {
    kind: K;
    /** Its settings. Null while it was never saved, and for a viewer without the admin role. */
    settings: NoticeServiceSettingsByKind[K] | null;
    /** Who last saved it and when. Null while it was never saved, and for a viewer without the admin role. */
    savedBy: string | null;
    savedAt: string | null;
  };
}[NoticeServiceKind];

// ---------------------------------------------------------- my notifications

/**
 * `PUT /api/notifications/me/destinations/:kind`: save where my notices go on a service, behind my password as a save
 * of a service is: a changed address changes where the alerts go. The address is checked by
 * `destinationAddressProblem`: 400 `validation_error` with its sentence in `errors`. A destination saved for the first
 * time starts on, and a later save keeps its switch. My first saved destination ticks {@link STARTING_NOTICE_TOPICS}
 * for me, unless I saved my topics before.
 */
export interface MyDestinationSaveRequest {
  password: string;
  address: string;
}

/** `PUT /api/notifications/me/topics`: the topics I get, all of them, ticked or not by being in the list or out of it. */
export interface MyNoticeTopicsRequest {
  topics: NoticeTopic[];
}

/** One of my destinations: where my notices go on one service, and how it last went. No other user reads it. */
export interface MyDestination {
  kind: NoticeServiceKind;
  /** The email address or the Telegram chat's id, or null while I saved none. */
  address: string | null;
  /** Whether my notices go to it. One never saved is off. */
  enabled: boolean;
  /** When I last saved it, or null. */
  savedAt: string | null;
  /** When it last took a notice, or null. A test notice does not count. */
  lastSentAt: string | null;
  /** Why its last notice could not be sent, in a sentence, or null once one went out after it. */
  lastError: string | null;
  /** When that was, or null. */
  lastErrorAt: string | null;
  /** How many notices wait for it: ones it could not take whose news another destination took. */
  waiting: number;
  /** When I last sent a test notice to it, or null. */
  lastTestAt: string | null;
  /** Why that test could not be sent, in a sentence, or null when it went out or none was sent. */
  lastTestError: string | null;
}

/** How many people get a topic's notices: users who ticked it and have a destination that is on, on a service that is. */
export interface NoticeTopicReach {
  topic: NoticeTopic;
  people: number;
}

/**
 * `GET /api/notifications`, and what every write of the page answers. Of the other users it holds numbers alone: no
 * address, no tick and no failure of theirs.
 */
export interface NoticesView {
  /**
   * Whether a service can be saved and a notice sent: the admin has `BRAND_WALLET_SECRET`, which the services' secrets
   * are sealed under. False, a save answers 409 `notifications_unavailable`.
   */
  available: boolean;
  /** Whether the viewer may save, switch and remove the services: a user with the admin role. */
  managesServices: boolean;
  /** Every service, in the order of `NOTICE_SERVICE_KINDS`, saved or not. */
  services: NoticeServiceView[];
  /** My destination on each service, in the same order, saved or not. */
  destinations: MyDestination[];
  /** The topics I ticked, in the order of {@link NOTICE_TOPICS}. */
  topics: NoticeTopic[];
  /** Every topic, in the order of {@link NOTICE_TOPICS}, with how many people get it. */
  reach: NoticeTopicReach[];
}

/**
 * How many people get a topic's notices. With 0, a notice of the topic shows only on the page of whoever raised it:
 * the Auto top-up tab for stamp auto top-up.
 */
export function noticePeople(view: Pick<NoticesView, 'reach'>, topic: NoticeTopic): number {
  return view.reach.find((reach) => reach.topic === topic)?.people ?? 0;
}

/**
 * `POST /api/notifications/me/destinations/:kind/test`: what became of my test notice. It goes to my saved
 * destination, on or off, through the saved service, on or off, and says who asked for it and when: 409
 * `destination_not_saved`, `service_not_saved` and `notifications_unavailable` without one of them, and 429
 * `test_too_soon` within a minute of my last test there. It counts in no rule: `lastSentAt`, `lastError` and the
 * waiting notices stay as they were, the service's as well as mine.
 */
export interface MyNoticeTestResponse {
  /** Whether the service took it. */
  sent: boolean;
  /** Why it could not be sent, in a sentence, or null. */
  error: string | null;
  view: NoticesView;
}

/**
 * `POST /api/notifications/me/telegram/code`: a code for me to send to the bot from the chat my notices are to go to,
 * and the bot to send it to. It takes no body, holds for {@link TELEGRAM_CHAT_CODE_SECONDS} and replaces the code I
 * had. The bot is read from Telegram with the saved service's token: 409 `service_not_saved` and
 * `notifications_unavailable` without one. A session is enough: it changes nothing at Telegram and no destination.
 */
export interface TelegramCodeResponse {
  /** The code, or null when the bot could not be read. `telegramStartLink` makes the link that sends it. */
  code: string | null;
  /** Until when it holds, or null. */
  expiresAt: string | null;
  /** The bot to send it to, or null when it could not be read. */
  bot: TelegramBot | null;
  /** Why Telegram could not be asked or its answer read, in a sentence that holds no token, or null. */
  error: string | null;
}

/**
 * `POST /api/notifications/me/telegram/chat`: Find my chat. It takes no body and answers the chat that sent my code to
 * the bot, which the page fills in as my Telegram destination for me to save: 409 `code_not_started` with no code that
 * holds, and 409 `service_not_saved` and `notifications_unavailable` as above. It answers that one chat and lists no
 * other. A session is enough: it changes nothing at Telegram and no destination.
 */
export interface TelegramChatResponse {
  /** The chat that sent my code, or null: none of the bot's latest messages holds it yet, or Telegram could not be asked. */
  chat: TelegramChat | null;
  /** Why Telegram could not be asked or its answer read, in a sentence that holds no token, or null. */
  error: string | null;
}
