import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationsView,
  type NotificationTestResponse,
  PASSWORD_MAX_LENGTH,
  type TelegramChatsResponse,
} from '@streaming-monorepo/web2-admin-common';
import { clientIpOf } from '@streaming-monorepo/web-auth';
import { Request, RequestHandler, Response, Router } from 'express';
import { boolean, mixed, object, string } from 'yup';

import type { AuthService } from '../../domain/auth/AuthService.js';
import type { NotificationService } from '../../domain/notifications/NotificationService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, signedInSession } from '../middleware/requireAuth.js';
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
