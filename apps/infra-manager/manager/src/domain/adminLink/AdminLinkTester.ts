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
 * uploader. A stored token never reaches a page and is presented only to the
 * origin it was stored for, and an answer is the outcome code alone. The log line names who asked and the outcome, never the
 * address or a token.
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

  /** Tests an address typed on the Manager settings page or in the new-deployment wizard. */
  async testTyped(request: AdminLinkTestRequest, username: string): Promise<AdminLinkTestAnswer> {
    const problems = adminLinkTestProblems(request);
    if (problems.length > 0) throw new AdminLinkInputError(problems);
    const outcome =
      request.token.source === 'typed'
        ? await this.probe({ url: request.url, token: request.token.value, feedOwner: request.feedOwner ?? null })
        : await this.outcomeWithStoredToken(request);
    logger.info(`[AdminLink] ${username} tested a web2 admin link typed on a page: ${outcome}`);
    return { outcome };
  }

  /** The stored token goes only to the origin it was saved with, so an address elsewhere is answered without asking it. */
  private async outcomeWithStoredToken(request: AdminLinkTestRequest): Promise<AdminLinkTestOutcome> {
    const stored = await this.store.storedLink();
    if (stored.token === null) return 'no-token';
    if (!sameAdminOrigin(request.url, stored.url ?? '')) return 'stored-token-elsewhere';
    return this.probe({ url: request.url, token: stored.token, feedOwner: request.feedOwner ?? null });
  }

  /**
   * Tests what the deployment's next deploy would give its uploader. A token
   * the deployment stores is presented only to the origin it was stored for,
   * which is what the deploy holds it to as well. The feed owner compared is
   * the address of the stream key the deploy gives, whether the deployment
   * stores it or its version's base .env sets it. Every stage signs with a key
   * of its own, so the probe compares it with the owner the admin knows for
   * the stage the token belongs to, `GET /api/internal/stages/self`, and on a
   * token that belongs to no stage, the shared one, with the admin's catalog
   * owner, as the uploader's boot check does.
   */
  async testDeployment(name: string, username: string): Promise<AdminLinkTestAnswer> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    const { env } = await this.orchestrator.nextEnvFor(profile);
    const url = env[ADMIN_API_URL_KEY] ?? '';
    const token = env[ADMIN_API_TOKEN_KEY] ?? '';
    const storedWith = (await this.profiles.stackSettingsOf(name))?.adminTokenOrigin ?? null;
    let outcome =
      storedWith !== null && url !== '' && !sameAdminOrigin(url, storedWith)
        ? 'stored-token-elsewhere'
        : await this.outcomeFor({ url, token, feedOwner: addressOfStreamKey(env.STREAM_KEY ?? '') });
    if (outcome === 'token-refused' && (await this.notRegisteredYet(name, url, token)))
      outcome = 'token-not-registered';
    logger.info(`[AdminLink] ${username} tested the web2 admin link of ${name}: ${outcome}`);
    return { outcome };
  }

  /**
   * Whether a refused token is the deployment's own, which the admin learns from the stage record, at an address on
   * the manager's link, while no push of the record has been stored there yet. The admin knows an uploader's own
   * token by its sha256 on the record alone, so until then it refuses it as any unknown token. A token that is the
   * link's is the shared one, which the admin takes without a record.
   */
  private async notRegisteredYet(name: string, url: string, token: string): Promise<boolean> {
    if (!this.pushes) return false;
    const link = await this.store.storedLink();
    if (link.token === null || link.token === token || !sameAdminOrigin(url, link.url ?? '')) return false;
    const last = this.pushes.lastPush(name);
    return last === null || (last.outcome !== 'stored' && last.outcome !== 'older-ignored');
  }

  /** Answers without asking anything when there is no address to ask, one the uploader could not use, or no token. */
  private async outcomeFor(target: AdminLinkProbeTarget): Promise<AdminLinkTestOutcome> {
    if (target.url === '') return 'not-linked';
    if (adminUrlProblem(target.url) !== null) return 'invalid-address';
    if (target.token === '') return 'no-token';
    return this.probe(target);
  }
}
