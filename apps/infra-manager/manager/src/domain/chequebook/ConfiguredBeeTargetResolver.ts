import { createHash } from 'node:crypto';
import { BEE_UPLOADER_SERVICE, ownsBeeNode } from '@streaming-infra-manager/common';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { beeApiUrlFor } from '../StampService.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import type { CaptureTransferTarget, ConfiguredBeeTarget } from './ChequebookTransferPreparation.js';

/**
 * The bee API address a chequebook transfer is prepared against, worked out
 * from the deployment's own row and its running containers, with the SQL
 * ownership the journal admits a transfer under: the frozen target carries the
 * port the deployment's reservation owns, and the journal refuses a transfer
 * that brings no such target.
 *
 * TODO (Dev-1): the port it takes is the one the container reports. Before
 * anything is sent it must equal `submissionTarget.reservation.port`, the port
 * the reservation says this deployment owns, or the transfer is refused;
 * until then a transfer can be prepared against a port another deployment has
 * since been given.
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
      if (!profile || !ownsBeeNode(profile) || ['DEPLOYING', 'STOPPING', 'REMOVING'].includes(profile.status))
        throw new ChequebookPreparationError();
      const bees = (await this.containers.listApiContainers(profileName)).filter(
        (container) => container.service === BEE_UPLOADER_SERVICE,
      );
      const port = bees[0]?.ports.BEE_UPLOADER_API_PORT;
      if (bees.length !== 1 || !Number.isInteger(port) || port! < 1 || port! > 65535)
        throw new ChequebookPreparationError();
      const url = new URL(beeApiUrlFor(profile));
      url.port = String(port);
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new ChequebookPreparationError();
      const submissionTarget = await this.captureTarget(profile.name, profile.instance_id);
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
      throw ChequebookPreparationError.keeping(error);
    }
  }
}
