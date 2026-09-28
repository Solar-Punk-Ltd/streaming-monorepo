import type { SessionInfo } from '../domain/auth/AuthService.js';
import type { UploaderCaller } from '../domain/uploaderScope.js';

import type { UserRow } from './rows.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Use requireUser(req) to read it type-safely. */
      user?: UserRow;
      /**
       * sha256 of the presented session cookie: which of the user's sessions
       * this request is. A password change keeps this one and revokes the rest.
       */
      sessionTokenHash?: string;
      /** The whole session, including when it runs out. Set by requireAuth. */
      authSession?: SessionInfo;
      /**
       * Which uploader called one of the uploader's routes under /api/internal: a stage, by its own token. Set by
       * requireUploaderToken; read it with uploaderCallerOf(req).
       */
      uploaderCaller?: UploaderCaller;
    }
  }
}
