import {
  ADMIN_LINK_ALLOW_PLAIN_HTTP_KEY,
  type ManagerAdminLink,
  type ManagerAdminLinkSave,
  managerAdminLinkProblems,
} from '@streaming-infra-manager/common';

import { AdminLinkInputError, ManagerSettingsChangedError } from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { ManagerAdminLinkStore, ManagerAdminLinkWrite } from './ManagerAdminLinkRepository.js';
import { judgePlainHttpAdminLink, type PlainHttpJudge } from './plainHttpAdminLink.js';

const logger = Logger.getInstance();

/** A save as the store takes it: an empty address is no default, which takes the token with it. */
function writeOf(save: ManagerAdminLinkSave): ManagerAdminLinkWrite {
  if (save.url === '') return { url: null };
  return save.token === undefined ? { url: save.url } : { url: save.url, token: save.token };
}

/** What the log says a save did, which never names the address or the token. */
function describeSave(save: ManagerAdminLinkSave): string {
  if (save.url === '') return 'removed the web2 admin link for new deployments';
  const token =
    save.token === undefined ? 'kept its token' : save.token === null ? 'cleared its token' : 'replaced its token';
  return `set the web2 admin link for new deployments and ${token}`;
}

/**
 * The web2 admin link every new uploader deployment starts with, which the
 * Manager settings page reads and saves. The token is never answered, only
 * whether one is stored.
 */
export class ManagerAdminLinkService {
  constructor(
    private readonly store: ManagerAdminLinkStore,
    /** The rule for plain http to another host than the manager's own, which a save is refused under. */
    private readonly plainHttp: PlainHttpJudge = judgePlainHttpAdminLink,
  ) {}

  read(): Promise<ManagerAdminLink> {
    return this.store.read();
  }

  /**
   * Stores one save, or refuses all of it, and answers the link as it stands
   * after. The save is judged against the link it names the revision of, and
   * the write lands only while the row is still at that revision. An address in
   * plain http to another host than the manager's own is refused, unless
   * ADMIN_LINK_ALLOW_PLAIN_HTTP is on, which the log then says. One to a name
   * that does not resolve yet, an admin service not started, is taken, and
   * every send judges it once it resolves.
   */
  async save(save: ManagerAdminLinkSave, username: string): Promise<ManagerAdminLink> {
    const stored = await this.store.read();
    if (stored.revision !== save.expectedRevision) throw new ManagerSettingsChangedError();
    const plainHttp = save.url === '' ? 'allowed' : await this.plainHttp(save.url);
    const problems = managerAdminLinkProblems(save, stored, plainHttp);
    if (problems.length > 0) throw new AdminLinkInputError(problems);
    const saved = await this.store.write(writeOf(save), save.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(`[AdminLink] ${username} ${describeSave(save)}, now at revision ${saved.revision}`);
    if (plainHttp === 'allowed-by-setting') {
      logger.warn(
        `[AdminLink] the web2 admin link is plain http to another host, taken because ${ADMIN_LINK_ALLOW_PLAIN_HTTP_KEY} is on: every push to it carries the stored token and each stage’s SRT passphrase in clear, so give it the https address the edge serves in production`,
      );
    }
    return saved;
  }
}
