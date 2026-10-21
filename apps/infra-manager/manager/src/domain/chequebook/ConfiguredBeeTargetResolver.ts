import { createHash } from 'node:crypto';
import { BEE_UPLOADER_SERVICE, ownsBeeNode } from '@streaming-infra-manager/common';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { beeApiUrlFor } from '../StampService.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import { ChequebookProfileChangedError } from '../errors/ChequebookProfileChangedError.js';
import type { CaptureTransferTarget, ConfiguredBeeTarget } from './ChequebookTransferPreparation.js';

/** The states a deployment is between two shapes in, whose node a transfer must not be prepared against. */
const CHANGING = ['DEPLOYING', 'STOPPING', 'REMOVING'];

/**
 * The bee API address a chequebook transfer is prepared against, worked out
 * from the deployment's own row and its running containers, with the SQL
 * ownership the journal admits a transfer under: the frozen target carries the
 * port the deployment's reservation owns, and the journal refuses a transfer
 * that brings no such target.
 *
 * The port the `bee-uploader` container recorded must be the one the
 * reservation says this deployment owns, or nothing is prepared: a port another
 * deployment has since been given is never dialled. Every refusal names its
 * cause. A deployment between two shapes, or more than one Bee container
 * recorded for it, is `target_changed`. No Bee container is
 * `bee_container_not_found`. A recorded port that is missing, out of range or
 * not the reserved one is `bee_container_unsupported`. A deployment the capture
 * finds removed or replaced keeps its own error, answered as 409.
 */
export class ConfiguredBeeTargetResolver {
  constructor(
    private readonly profiles: Pick<ProfileRepository, 'findByName'>,
    private readonly containers: Pick<ContainerRepository, 'listApiContainers'>,
    private readonly captureTarget: CaptureTransferTarget,
  ) {}

  async resolve(profileName: string): Promise<ConfiguredBeeTarget> {
    try {
      const profile = await this.profiles.findByName(profileName);
      if (!profile || !ownsBeeNode(profile)) throw new ChequebookPreparationError();
      if (CHANGING.includes(profile.status)) throw new ChequebookPreparationError('target_changed');
      const bees = (await this.containers.listApiContainers(profileName)).filter(
        (container) => container.service === BEE_UPLOADER_SERVICE,
      );
      if (bees.length === 0) throw new ChequebookPreparationError('bee_container_not_found');
      if (bees.length !== 1) throw new ChequebookPreparationError('target_changed');
      const port = bees[0]!.ports.BEE_UPLOADER_API_PORT;
      if (!Number.isInteger(port) || port! < 1 || port! > 65535)
        throw new ChequebookPreparationError('bee_container_unsupported');
      const url = new URL(beeApiUrlFor(profile));
      url.port = String(port);
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new ChequebookPreparationError();
      const submissionTarget = await this.captureTarget(profile.name, profile.instance_id);
      if (submissionTarget.reservation.port !== port) throw new ChequebookPreparationError('bee_container_unsupported');
      const revision = createHash('sha256')
        .update(
          JSON.stringify([
            profile.name,
            profile.instance_id,
            profile.created_at.toISOString(),
            profile.updated_at.toISOString(),
            profile.host,
            profile.port_slot,
            profile.kind,
            profile.components,
            profile.status,
            profile.stack_version_id,
            port,
            url.href,
          ]),
        )
        .digest('hex');
      return Object.freeze({
        topology: 'operator_asserted_direct',
        profileInstanceId: profile.instance_id,
        url: url.href,
        revision,
        submissionTarget,
      });
    } catch (error) {
      if (error instanceof ChequebookProfileChangedError) throw error;
      throw ChequebookPreparationError.keeping(error);
    }
  }
}
