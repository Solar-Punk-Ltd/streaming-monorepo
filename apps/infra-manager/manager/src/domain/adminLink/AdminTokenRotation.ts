import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  ADMIN_TOKEN_ROTATED_MESSAGE,
  type AdminTokenRotateAnswer,
  engineForComponents,
} from '@streaming-infra-manager/common';

import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
import {
  ProfileBusyError,
  ProfileConfigError,
  ProfileInstanceChangedError,
  ProfileNotFoundError,
} from '../errors/index.js';
import type { EventBus } from '../EventBus.js';
import { Logger } from '../Logger.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { versionSuppliedSecrets } from '../versions/versionSuppliedSecrets.js';

import type { ManagerAdminLinkStore } from './ManagerAdminLinkRepository.js';
import { ownAdminTokenFor, runsStreamUploader, takesOwnAdminToken } from './ownAdminToken.js';

const logger = Logger.getInstance();

/**
 * Rotate the uploader's admin token, from the deployment page: the token the deployment's uploader presents to the
 * web2 admin is taken out, the one the manager generated and one stored in its settings alike, so its next deploy
 * generates a new one of its own and registers its sha256 with the admin before the uploader starts.
 *
 * Nothing that runs changes here. The running uploader keeps the token it was started with until the redeploy, and
 * the admin stops taking it once the manager next pushes the stage, whose record then carries no token. It is the
 * one way back for an uploader on a token the manager did not generate, typed or copied from the link by an older
 * manager, which the admin refuses. The log names who rotated which deployment, never a token.
 */
export class AdminTokenRotation {
  constructor(
    private readonly profiles: Pick<ProfileRepository, 'findByName' | 'clearAdminToken'>,
    private readonly orchestrator: Pick<DeploymentOrchestrator, 'nextEnvFor'>,
    private readonly link: Pick<ManagerAdminLinkStore, 'read'>,
    private readonly containers: Pick<ContainerRepository, 'withContainers'>,
    private readonly events: Pick<EventBus, 'publish'>,
  ) {}

  /**
   * Refused, with a sentence, for a deployment that runs no stream uploader, one in the middle of a deploy, stop or
   * removal, and one whose next deploy would generate no token of its own: its uploader is given another address
   * than the manager's link, the link has no token to register it with, or its version's env files set the token.
   */
  async rotate(name: string, username: string): Promise<AdminTokenRotateAnswer> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    if (TRANSITIONAL_STATUSES.includes(profile.status)) throw new ProfileBusyError(name, profile.status);
    if (!runsStreamUploader(profile)) {
      throw new ProfileConfigError(
        name,
        'This deployment runs no stream uploader, so it has no admin token to rotate.',
      );
    }

    const next = await this.orchestrator.nextEnvFor(profile);
    const ownTokenFor = ownAdminTokenFor(await this.link.read(), profile);
    if (!takesOwnAdminToken(next.env[ADMIN_API_URL_KEY] ?? '', ownTokenFor)) {
      throw new ProfileConfigError(
        name,
        ownTokenFor === null
          ? `The manager has no web2 admin link with a token, so a deploy could not register a new ${ADMIN_API_TOKEN_KEY} with the admin. Save the link on Manager settings first.`
          : `The uploader is given another address than the manager's web2 admin link, so its next deploy would generate no ${ADMIN_API_TOKEN_KEY} of its own. Change ${ADMIN_API_TOKEN_KEY} on the Stack settings card instead.`,
      );
    }
    if (versionSuppliedSecrets(next.root, engineForComponents(profile.components), [ADMIN_API_TOKEN_KEY]).size > 0) {
      throw new ProfileConfigError(
        name,
        `This deployment's version sets ${ADMIN_API_TOKEN_KEY} in its env files, and a deploy writes that value in place of a token of its own.`,
      );
    }

    const updated = await this.profiles.clearAdminToken(name, profile.instance_id);
    if (!updated) {
      // The statement refuses a row that moved since the read above: say which way it moved.
      const now = await this.profiles.findByName(name);
      if (now && now.instance_id === profile.instance_id && TRANSITIONAL_STATUSES.includes(now.status)) {
        throw new ProfileBusyError(name, now.status);
      }
      throw new ProfileInstanceChangedError(name);
    }
    logger.info(`[AdminLink] ${username} rotated the web2 admin token of ${name}: its next deploy generates a new one`);
    // The stage publisher pushes on this, so the admin stops taking the old token without waiting for the interval.
    this.events.publish({ type: 'profile.changed', profile: await this.containers.withContainers(updated) });
    return { message: ADMIN_TOKEN_ROTATED_MESSAGE };
  }
}
