import {
  type MyNoticeTestResponse,
  NOTICE_SERVICE_KINDS,
  type NoticeServiceKind,
  type NoticesView,
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationsView,
  type NotificationTestResponse,
  PASSWORD_MAX_LENGTH,
  type TelegramChatResponse,
  type TelegramChatsResponse,
  type TelegramCodeResponse,
} from '@streaming-monorepo/web2-admin-common';
import { clientIpOf } from '@streaming-monorepo/web-auth';
import { Request, RequestHandler, Response, Router } from 'express';
import { boolean, mixed, object, string } from 'yup';

import type { AuthService } from '../../domain/auth/AuthService.js';
import type { NoticeService, NoticeUser } from '../../domain/notifications/NoticeService.js';
import type { NotificationService } from '../../domain/notifications/NotificationService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, requireAdmin, requireUser, signedInSession } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export interface NotificationRoutesDeps {
  notifications: Pick<NotificationService, 'view' | 'save' | 'setEnabled' | 'remove' | 'test' | 'telegramChats'>;
  /** The password check saving a channel asks for, a send's own. */
  authService: Pick<AuthService, 'confirmPassword'>;
  requireAuth: RequestHandler;
}

const kindParamsSchema = object({
  kind: mixed<NotificationChannelKind>()
    .required()
    .oneOf([...NOTIFICATION_CHANNEL_KINDS], `kind is one of ${NOTIFICATION_CHANNEL_KINDS.join(', ')}`),
});

/**
 * The operator's password, bounded as a send's is; the settings of any shape, which `channelSettingsProblems` reads;
 * the secret, or null or empty to keep it. The password's and the secret's sentences are the schema's own, since yup's
 * default one repeats the value it refused.
 */
const saveSchema = object({
  password: string().typeError('password is a string').required('password is required').max(PASSWORD_MAX_LENGTH),
  settings: mixed().defined('settings are required'),
  secret: string().typeError('secret is a string, or null to keep the saved one').nullable(),
}).noUnknown(true);

const enabledSchema = object({ enabled: boolean().required('enabled is true or false') }).noUnknown(true);

/** The bot's token as typed, or null or left out for the saved one. The sentence is the schema's own, as above. */
const telegramChatsSchema = object({
  secret: string().typeError("secret is the bot's token, or null for the saved one").nullable(),
}).noUnknown(true);

function kindOf(req: Request): NotificationChannelKind {
  return String(req.params.kind) as NotificationChannelKind;
}

/**
 * The Notifications page's routes, under `/api/notifications` (`NOTIFICATIONS_PATH`), behind the session; the writes
 * behind the same-site check as well, which `src/api/server.ts` runs ahead of every console route. `:kind` is one of
 * `NOTIFICATION_CHANNEL_KINDS`, and any other answers 400.
 *
 * - `GET /` answers `NotificationsView`.
 * - `PUT /channels/:kind` takes `NotificationChannelSaveRequest`, behind the operator's password as a send is: 401
 *   `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked out, then 400 `validation_error` with a
 *   sentence for each problem of the settings and the secret, and 409 `notifications_unavailable` without
 *   `BRAND_WALLET_SECRET`. It answers the view.
 * - `PUT /channels/:kind/enabled` takes `NotificationChannelEnabledRequest`, with no password: 409 `channel_not_saved`
 *   for a channel never saved. It answers the view.
 * - `POST /channels/:kind/test` takes no body: 409 `notifications_unavailable` and `channel_not_saved` as above, and
 *   429 `test_too_soon` with `retryAfterSeconds` within a minute of the channel's last test. It answers
 *   `NotificationTestResponse`.
 * - `POST /channels/telegram/chats` takes `TelegramChatsRequest`, with no password: Find chat id, which reads the
 *   chats that wrote to the bot within the last day. 400 `validation_error` for a typed token the rules refuse; with
 *   none typed, 409 `notifications_unavailable` and `channel_not_saved` as above. It answers `TelegramChatsResponse`.
 * - `DELETE /channels/:kind`, with no password, removes the channel with its secret, and answers the view.
 */
export function createNotificationsRouter(deps: NotificationRoutesDeps): Router {
  const { notifications, authService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const response: NotificationsView = await notifications.view();
      res.json(response);
    }),
  );

  router.put(
    '/channels/:kind',
    validateParams(kindParamsSchema),
    validateBody(saveSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { password: string; settings: unknown; secret?: string | null };
      await authService.confirmPassword(
        signedInSession(req),
        body.password,
        'notification channel save',
        clientIpOf(req),
      );
      const response: NotificationsView = await notifications.save(actorOf(req), kindOf(req), {
        settings: body.settings,
        secret: body.secret ?? null,
      });
      res.json(response);
    }),
  );

  router.put(
    '/channels/:kind/enabled',
    validateParams(kindParamsSchema),
    validateBody(enabledSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { enabled } = req.body as { enabled: boolean };
      const response: NotificationsView = await notifications.setEnabled(actorOf(req), kindOf(req), enabled);
      res.json(response);
    }),
  );

  router.post(
    '/channels/:kind/test',
    validateParams(kindParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: NotificationTestResponse = await notifications.test(actorOf(req), kindOf(req));
      res.json(response);
    }),
  );

  router.post(
    '/channels/telegram/chats',
    validateBody(telegramChatsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { secret } = req.body as { secret?: string | null };
      const response: TelegramChatsResponse = await notifications.telegramChats(actorOf(req), secret ?? null);
      res.json(response);
    }),
  );

  router.delete(
    '/channels/:kind',
    validateParams(kindParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: NotificationsView = await notifications.remove(actorOf(req), kindOf(req));
      res.json(response);
    }),
  );

  return router;
}

export interface NoticeRoutesDeps {
  notices: Pick<
    NoticeService,
    | 'view'
    | 'saveService'
    | 'setServiceEnabled'
    | 'removeService'
    | 'saveDestination'
    | 'setDestinationEnabled'
    | 'removeDestination'
    | 'saveTopics'
    | 'test'
    | 'telegramCode'
    | 'telegramChat'
  >;
  /** The password check a save of a service or of a destination asks for, a send's own. */
  authService: Pick<AuthService, 'confirmPassword'>;
  requireAuth: RequestHandler;
}

const serviceKindParamsSchema = object({
  kind: mixed<NoticeServiceKind>()
    .required()
    .oneOf([...NOTICE_SERVICE_KINDS], `kind is one of ${NOTICE_SERVICE_KINDS.join(', ')}`),
});

/** The password's sentences are the schema's own, since yup's default one repeats the value it refused. */
const passwordSchema = string()
  .typeError('password is a string')
  .required('password is required')
  .max(PASSWORD_MAX_LENGTH);

/** The settings of any shape, which `serviceSettingsProblems` reads, and the secret, or null or empty to keep it. */
const serviceSaveSchema = object({
  password: passwordSchema,
  settings: mixed().defined('settings are required'),
  secret: string().typeError('secret is a string, or null to keep the saved one').nullable(),
}).noUnknown(true);

/** The address of any shape, which `destinationAddressProblem` reads. */
const destinationSaveSchema = object({
  password: passwordSchema,
  address: mixed().defined('address is required'),
}).noUnknown(true);

/** The topics of any shape, which `noticeTopicsProblem` reads. */
const topicsSchema = object({ topics: mixed().defined('topics are required') }).noUnknown(true);

function serviceKindOf(req: Request): NoticeServiceKind {
  return String(req.params.kind) as NoticeServiceKind;
}

/** The session's own user, and whether they have the admin role: never a user named by the request. */
function noticeUserOf(req: Request): NoticeUser {
  return { ...actorOf(req), isAdmin: requireUser(req).user.is_admin };
}

/**
 * The Notifications page's routes, under `/api/notifications` (`NOTIFICATIONS_PATH`), behind the session; the writes
 * behind the same-site check as well, which `src/api/server.ts` runs ahead of every console route. `:kind` is one of
 * `NOTICE_SERVICE_KINDS`, and any other answers 400. Every write answers the view, as `GET /` does.
 *
 * - `GET /` answers `NoticesView` for the session's user.
 * - Under `/services`, for a user with the admin role alone, 403 `admin_required` for any other, before anything else
 *   is read: `PUT /services/:kind` takes `NoticeServiceSaveRequest`, behind the password (401 `invalid_credentials`,
 *   429 `too_many_attempts`), then 400 `validation_error` for the settings and the secret and 409
 *   `notifications_unavailable` without `BRAND_WALLET_SECRET`; `PUT /services/:kind/enabled` takes
 *   `NoticeEnabledRequest` (409 `service_not_saved`); `DELETE /services/:kind` removes the service with its secret.
 * - Under `/me`, the session's own user's: `PUT /me/destinations/:kind` takes `MyDestinationSaveRequest`, behind the
 *   password as above, then 400 for the address; `PUT /me/destinations/:kind/enabled` takes `NoticeEnabledRequest`
 *   (409 `destination_not_saved`); `DELETE /me/destinations/:kind`; `PUT /me/topics` takes `MyNoticeTopicsRequest`;
 *   `POST /me/destinations/:kind/test` answers `MyNoticeTestResponse` (409 `destination_not_saved`,
 *   `service_not_saved`, `notifications_unavailable`, 429 `test_too_soon`); `POST /me/telegram/code` answers
 *   `TelegramCodeResponse` and `POST /me/telegram/chat` `TelegramChatResponse` (409 `service_not_saved`,
 *   `notifications_unavailable`, and for the chat `code_not_started`).
 */
export function createNoticesRouter(deps: NoticeRoutesDeps): Router {
  const { notices, authService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const response: NoticesView = await notices.view(noticeUserOf(req));
      res.json(response);
    }),
  );

  // The shared services: a user with the admin role alone.

  router.put(
    '/services/:kind',
    requireAdmin,
    validateParams(serviceKindParamsSchema),
    validateBody(serviceSaveSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { password: string; settings: unknown; secret?: string | null };
      await authService.confirmPassword(
        signedInSession(req),
        body.password,
        'notification service save',
        clientIpOf(req),
      );
      const response: NoticesView = await notices.saveService(noticeUserOf(req), serviceKindOf(req), {
        settings: body.settings,
        secret: body.secret ?? null,
      });
      res.json(response);
    }),
  );

  router.put(
    '/services/:kind/enabled',
    requireAdmin,
    validateParams(serviceKindParamsSchema),
    validateBody(enabledSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { enabled } = req.body as { enabled: boolean };
      const response: NoticesView = await notices.setServiceEnabled(noticeUserOf(req), serviceKindOf(req), enabled);
      res.json(response);
    }),
  );

  router.delete(
    '/services/:kind',
    requireAdmin,
    validateParams(serviceKindParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: NoticesView = await notices.removeService(noticeUserOf(req), serviceKindOf(req));
      res.json(response);
    }),
  );

  // My own: the session's user's, and no other's.

  router.put(
    '/me/destinations/:kind',
    validateParams(serviceKindParamsSchema),
    validateBody(destinationSaveSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { password: string; address: unknown };
      await authService.confirmPassword(
        signedInSession(req),
        body.password,
        'notification destination save',
        clientIpOf(req),
      );
      const response: NoticesView = await notices.saveDestination(noticeUserOf(req), serviceKindOf(req), body.address);
      res.json(response);
    }),
  );

  router.put(
    '/me/destinations/:kind/enabled',
    validateParams(serviceKindParamsSchema),
    validateBody(enabledSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { enabled } = req.body as { enabled: boolean };
      const response: NoticesView = await notices.setDestinationEnabled(noticeUserOf(req), serviceKindOf(req), enabled);
      res.json(response);
    }),
  );

  router.post(
    '/me/destinations/:kind/test',
    validateParams(serviceKindParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: MyNoticeTestResponse = await notices.test(noticeUserOf(req), serviceKindOf(req));
      res.json(response);
    }),
  );

  router.delete(
    '/me/destinations/:kind',
    validateParams(serviceKindParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: NoticesView = await notices.removeDestination(noticeUserOf(req), serviceKindOf(req));
      res.json(response);
    }),
  );

  router.put(
    '/me/topics',
    validateBody(topicsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { topics } = req.body as { topics: unknown };
      const response: NoticesView = await notices.saveTopics(noticeUserOf(req), topics);
      res.json(response);
    }),
  );

  router.post(
    '/me/telegram/code',
    asyncHandler(async (req: Request, res: Response) => {
      const response: TelegramCodeResponse = await notices.telegramCode(noticeUserOf(req));
      res.json(response);
    }),
  );

  router.post(
    '/me/telegram/chat',
    asyncHandler(async (req: Request, res: Response) => {
      const response: TelegramChatResponse = await notices.telegramChat(noticeUserOf(req));
      res.json(response);
    }),
  );

  return router;
}
