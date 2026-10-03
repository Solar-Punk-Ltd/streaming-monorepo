import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  type DeploymentShape,
  type EngineName,
  engineOfServices,
  hasService,
  isRunning,
  OME_SERVICE,
  type RpcEndpointSource,
  servicesOf,
  shapeOf,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';

// What a deployment is and where it stands is declared in the common package
// with the readiness composition, which reads it, so the manager works a
// stage's readiness out the same way. It is passed on here so every page keeps
// importing it from one place.
export {
  type DeploymentShape,
  hasService,
  isRunning,
  isStreamLike,
  isTransitional,
  servicesOf,
  shapeOf,
  statusLabelOf,
} from '@streaming-infra-manager/common';

export const SHAPE_LABEL: Record<DeploymentShape, string> = {
  stream: 'Stream',
  viewer: 'Viewer',
  'bee-node': 'Bee node',
  'abr-uploader': 'ABR uploader',
  custom: 'Custom',
};

/** What a service is called in a sentence, for confirmations and toasts. */
export const SERVICE_LABEL: Record<string, string> = {
  [SRS_SERVICE]: 'SRS',
  [OME_SERVICE]: 'OvenMediaEngine',
  [STREAM_UPLOADER_SERVICE]: 'the uploader',
  [BEE_UPLOADER_SERVICE]: 'the Bee node',
  [CLIENT_SERVICE]: 'the web player',
  [BEE_GATEWAY_SERVICE]: 'the Swarm gateway',
};

export const SERVICE_DESCRIPTIONS: Record<string, string> = {
  [SRS_SERVICE]: 'media server (SRT ingest)',
  [OME_SERVICE]: 'media server (OvenMediaEngine)',
  [STREAM_UPLOADER_SERVICE]: 'uploads segments to Swarm',
  [BEE_UPLOADER_SERVICE]: 'own Bee node',
  [CLIENT_SERVICE]: 'web player',
  [BEE_GATEWAY_SERVICE]: 'Swarm gateway for the player',
};

/** A deployment that runs a Bee node of any kind, an uploader or a gateway. */
export function ownsAnyBeeNode(profile: Profile): boolean {
  return hasService(profile, BEE_UPLOADER_SERVICE) || hasService(profile, BEE_GATEWAY_SERVICE);
}

/**
 * Where this deployment's node reaches the chain.
 *
 * A row that says nothing takes the column's own default, the stack's
 * endpoint, which is what every deployment made before the endpoint source
 * was chosen at creation runs on.
 */
export function endpointSourceOf(profile: Profile): RpcEndpointSource {
  return profile.rpc_endpoint_source ?? DEFAULT_RPC_ENDPOINT_SOURCE;
}

export function engineOf(profile: Profile): EngineName | null {
  return engineOfServices(servicesOf(profile));
}

/** Everything on this manager that signs a feed, so a viewer can follow it. */
export function streamersOf(profiles: Profile[]): Profile[] {
  return profiles.filter(
    (profile) => Boolean(profile.public_key) && ['stream', 'abr-uploader'].includes(shapeOf(profile)),
  );
}

/**
 * Whether the page asks this deployment how its SRT link is holding up. Only
 * SRS prints SRT statistics, and only a running deployment has a link to read.
 * The container records alone are not enough, because the manager keeps them
 * after a deployment stops.
 */
export function readsSrtIngest(profile: Profile): boolean {
  return (
    isRunning(profile) &&
    engineOf(profile) === SRS_SERVICE &&
    profile.containers.some((container) => container.service === SRS_SERVICE)
  );
}
