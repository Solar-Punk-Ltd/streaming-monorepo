import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  type AdminLinkTestAnswer,
  type AdminLinkTestOutcome,
  type AdminLinkTestRequest,
  addressOfStreamKey,
  adminLinkTestProblems,
  adminUrlProblem,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

import type { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
import { AdminLinkInputError, ProfileNotFoundError } from '../errors/index.js';
import { Logger } from '../Logger.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import type { StagePublisher } from '../stages/StagePublisher.js';

import { type AdminLinkProbe, type AdminLinkProbeTarget, probeAdminLink } from './adminLinkProbe.js';
import type { ManagerAdminLinkStore } from './ManagerAdminLinkRepository.js';

const logger = Logger.getInstance();

/**
 * Test connection, from a page: an address typed there with a typed token or
 * the manager's stored one, and what a deployment's next deploy would give its
 * uploader. The manager's token is the web2 admin's registrar token, proved on
 * the admin's registrar check, and an uploader's is proved on what the
 * uploader asks. A stored token never reaches a page and is presented only to
 * the origin it was stored for, and an answer is the outcome code alone. The
 * log line names who asked and the outcome, never the address or a token.
 */
export class AdminLinkTester {
  constructor(
    private readonly store: Pick<ManagerAdminLinkStore, 'storedLink'>,
    private readonly profiles: Pick<ProfileRepository, 'findByName' | 'stackSettingsOf'>,
    private readonly orchestrator: Pick<DeploymentOrchestrator, 'nextEnvFor'>,
    private readonly probe: AdminLinkProbe = probeAdminLink,
    /** The stage publisher's last push per deployment, which tells a token not registered yet from one refused. */
    private readonly pushes?: Pick<StagePublisher, 'lastPush'>,
  ) {}

  /**
   * Tests an address typed on the Manager settings page or in the new-deployment wizard. The stored token, and a typed
   * one that is not said to be an uploader's, is the registrar's; a typed uploader's token is compared with the
   * stream address, as the uploader will at boot.
   */
  async testTyped(request: AdminLinkTestRequest, username: string): Promise<AdminLinkTestAnswer> {
    const problems = adminLinkTestProblems(request);
    if (problems.length > 0) throw new AdminLinkInputError(problems);
    const outcome =
      request.token.source === 'stored'
        ? await this.outcomeWithStoredToken(request.url)
        : request.tokenFor === 'uploader'
          ? await this.probe({
              url: request.url,
              token: request.token.value,
              check: 'uploader',
              feedOwner: request.feedOwner ?? null,
            })
          : await this.probe({ url: request.url, token: request.token.value, check: 'registrar', feedOwner: null });
    logger.info(`[AdminLink] ${username} tested a web2 admin link typed on a page: ${outcome}`);
    return { outcome };
  }

  /** The stored token goes only to the origin it was saved with, so an address elsewhere is answered without asking it. */
  private async outcomeWithStoredToken(url: string): Promise<AdminLinkTestOutcome> {
    const stored = await this.store.storedLink();
    if (stored.token === null) return 'no-token';
    if (!sameAdminOrigin(url, stored.url ?? '')) return 'stored-token-elsewhere';
    return this.probe({ url, token: stored.token, check: 'registrar', feedOwner: null });
  }

  /**
   * Tests what the deployment's next deploy would give its uploader. A token
   * the deployment stores is presented only to the origin it was stored for,
   * which is what the deploy holds it to as well. The feed owner compared is
   * the address of the stream key the deploy gives, whether the deployment
   * stores it or its version's base .env sets it. Every stage signs with a key
   * of its own, so the probe compares it with the owner the admin knows for
   * the stage the token belongs to, `GET /api/internal/stages/self`, as the
   * uploader's boot check does.
   *
   * A refused token is told apart by where it came from. The deployment's own,
   * at the link's address before any push of its stage was stored there, is
   * `token-not-registered`, since a deploy registers it. Any other token at the
   * link's address, typed, copied from the link by an older manager, or the
   * version's, is `token-not-own`: the admin takes only a token of the
   * deployment's own from an uploader, and a rotation gives it one.
   */
  async testDeployment(name: string, username: string): Promise<AdminLinkTestAnswer> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    const { env, ownAdminToken } = await this.orchestrator.nextEnvFor(profile);
    const url = env[ADMIN_API_URL_KEY] ?? '';
    const token = env[ADMIN_API_TOKEN_KEY] ?? '';
    const storedWith = (await this.profiles.stackSettingsOf(name))?.adminTokenOrigin ?? null;
    let outcome =
      storedWith !== null && url !== '' && !sameAdminOrigin(url, storedWith)
        ? 'stored-token-elsewhere'
        : await this.outcomeFor({ url, token, check: 'uploader', feedOwner: addressOfStreamKey(env.STREAM_KEY ?? '') });
    if (outcome === 'token-refused') outcome = await this.whyRefused(name, url, ownAdminToken);
    logger.info(`[AdminLink] ${username} tested the web2 admin link of ${name}: ${outcome}`);
    return { outcome };
  }

  /**
   * Why the admin at the manager's link refused a deployment's token. The admin knows an uploader's own token by its
   * sha256 on the stage record alone, so until a push of the record is stored it refuses it as any unknown token. It
   * refuses every token the manager did not generate for the deployment. Elsewhere, the refusal is the admin's alone.
   */
  private async whyRefused(name: string, url: string, ownAdminToken: boolean): Promise<AdminLinkTestOutcome> {
    const link = await this.store.storedLink();
    if (link.token === null || !sameAdminOrigin(url, link.url ?? '')) return 'token-refused';
    if (!ownAdminToken) return 'token-not-own';
    const last = this.pushes?.lastPush(name);
    if (last === undefined) return 'token-refused';
    return last === null || (last.outcome !== 'stored' && last.outcome !== 'older-ignored')
      ? 'token-not-registered'
      : 'token-refused';
  }

  /** Answers without asking anything when there is no address to ask, one the uploader could not use, or no token. */
  private async outcomeFor(target: AdminLinkProbeTarget): Promise<AdminLinkTestOutcome> {
    if (target.url === '') return 'not-linked';
    if (adminUrlProblem(target.url) !== null) return 'invalid-address';
    if (target.token === '') return 'no-token';
    return this.probe(target);
  }
}
