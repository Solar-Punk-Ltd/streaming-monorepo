import { BEE_UPLOADER_SERVICE, ownsBeeNode } from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';

export interface FundingNodeApiDeps {
  profiles: { list(): Promise<Profile[]> };
  /** The Bee API of a deployment's own `bee-uploader`, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
}

/**
 * The deployment whose own `bee-uploader` a node of the funding inventory is, by the opaque id the inventory names it
 * with, `<instance_id>:<service>`, or null when this manager runs no such node now.
 *
 * Only a deployment's own `bee-uploader` is answered: a stage's own node, a pool's rung and the catalogue node are all
 * one. A gateway is not, and a deployment being removed is no longer one.
 */
export function fundingNodeDeployment(
  deps: Pick<FundingNodeApiDeps, 'profiles'>,
): (nodeId: string) => Promise<Profile | null> {
  return async (nodeId) => {
    const separator = nodeId.lastIndexOf(':');
    if (separator <= 0 || nodeId.slice(separator + 1) !== BEE_UPLOADER_SERVICE) return null;
    const instanceId = nodeId.slice(0, separator);
    const profile = (await deps.profiles.list()).find(
      (candidate) => candidate.instance_id === instanceId && candidate.status !== 'REMOVING' && ownsBeeNode(candidate),
    );
    return profile ?? null;
  };
}

/**
 * The Bee API of a node the funding inventory names, by the opaque id it names it with, `<instance_id>:<service>`, or
 * null when this manager runs no such node now.
 *
 * Only a deployment's own `bee-uploader` is answered ({@link fundingNodeDeployment}): they are the nodes that upload
 * with a batch. A gateway uploads with none, so no stamp operation asks one. The inventory works the same addresses
 * out with the same `uploaderApiUrl`, so the node asked is the node read. The address never leaves the manager.
 */
export function fundingNodeApiUrl(deps: FundingNodeApiDeps): (nodeId: string) => Promise<string | null> {
  const deploymentOf = fundingNodeDeployment(deps);
  return async (nodeId) => {
    const profile = await deploymentOf(nodeId);
    return profile ? deps.uploaderApiUrl(profile) : null;
  };
}
