/**
 * What a deployment is and where it stands, as far as its readiness needs to
 * know. They sit here with the readiness composition, so the manager can work
 * out a stage's readiness the way the console does. The console passes them on
 * unchanged.
 */

import { CLIENT_SERVICE, STREAM_UPLOADER_SERVICE } from './constants.js';
import type { DeploymentPhase } from './deploymentPhase.js';
import { engineOfServices } from './engines.js';
import type { NodeMode } from './nodeMode.js';
import {
  ABR_UPLOADER_KIND,
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  isBeeNodeOnly,
  servicesNeedStamp,
  usesNodePool,
} from './stampGating.js';

/**
 * The fields of a deployment the readiness composition reads. The console's
 * profile and the manager's row with its containers both have them, so either
 * is handed over as it is.
 */
export interface ReadinessProfile {
  name: string;
  kind: string;
  components?: string[] | null;
  stamp_id?: string | null;
  bee_publishers?: string | null;
  node_mode?: NodeMode | null;
  feed_owner?: string | null;
  public_key?: string | null;
  status: string;
  deployment_phase?: DeploymentPhase | null;
  containers: readonly { service: string }[];
}

/**
 * What a deployment is, in the words the operator uses.
 *
 * Read from the services it runs rather than from `kind`, because `kind` is a
 * creation-time label: a `custom` that happens to run an engine and an uploader
 * is a stream in every way that matters on screen, and a `streamer` whose
 * components were narrowed is not.
 */
export type DeploymentShape = 'stream' | 'viewer' | 'bee-node' | 'abr-uploader' | 'custom';

export function servicesOf(profile: ReadinessProfile): string[] {
  return defaultServicesFor(profile);
}

export function hasService(profile: ReadinessProfile, service: string): boolean {
  return servicesOf(profile).includes(service);
}

export function shapeOf(profile: ReadinessProfile): DeploymentShape {
  // Before the stream test: an ABR uploader runs an engine and an uploader too,
  // and it is the pool behind it, not its own node, that decides what it needs.
  if (profile.kind === ABR_UPLOADER_KIND) return 'abr-uploader';

  const services = servicesOf(profile);
  if (services.includes(STREAM_UPLOADER_SERVICE) && engineOfServices(services) !== null) {
    return 'stream';
  }
  if (services.includes(CLIENT_SERVICE)) return 'viewer';
  if (isBeeNodeOnly(profile)) return 'bee-node';
  return 'custom';
}

const TRANSITIONAL_STATUSES: readonly string[] = ['DEPLOYING', 'STOPPING', 'REMOVING'];

export function isRunning(profile: Pick<ReadinessProfile, 'status'>): boolean {
  return profile.status === 'RUNNING';
}

export function isTransitional(profile: Pick<ReadinessProfile, 'status'>): boolean {
  return TRANSITIONAL_STATUSES.includes(profile.status);
}

export interface StatusLabel {
  label: string;
  tone: 'ok' | 'warn' | 'err' | 'info' | 'gray';
}

const STATUS_LABELS: Record<string, StatusLabel> = {
  RUNNING: { label: 'Running', tone: 'ok' },
  DEPLOYING: { label: 'Deploying', tone: 'info' },
  STOPPING: { label: 'Stopping', tone: 'warn' },
  STOPPED: { label: 'Stopped', tone: 'gray' },
  REMOVING: { label: 'Removing', tone: 'warn' },
  ERROR: { label: 'Error', tone: 'err' },
};

export function statusLabelOf(profile: Pick<ReadinessProfile, 'status' | 'deployment_phase'>): StatusLabel {
  if (profile.status === 'DEPLOYING' && profile.deployment_phase) {
    return { label: profile.deployment_phase === 'starting' ? 'Starting' : 'Restarting', tone: 'info' };
  }
  return STATUS_LABELS[profile.status] ?? { label: profile.status, tone: 'gray' };
}

export function isStreamLike(profile: ReadinessProfile, shape = shapeOf(profile)): boolean {
  return (
    shape === 'stream' || (shape === 'custom' && hasService(profile, STREAM_UPLOADER_SERVICE) && !usesNodePool(profile))
  );
}

export function deploymentProgressText(profile: Pick<ReadinessProfile, 'status' | 'deployment_phase'>): string {
  switch (profile.status) {
    case 'DEPLOYING': {
      const phase =
        profile.deployment_phase === 'starting'
          ? 'Starting'
          : profile.deployment_phase === 'restarting'
            ? 'Restarting'
            : 'Deploying';
      return `${phase}. Ingest and current container state are not yet verified. Previous observations may describe the earlier deployment.`;
    }
    case 'STOPPING':
      return 'Stopping. Ingest and current container state are not yet verified.';
    case 'REMOVING':
      return 'Removing. Ingest and current container state are not yet verified.';
    case 'ERROR':
      return 'The last deployment action failed. Check the container logs for its current state.';
    case 'STOPPED':
      return 'The deployment is stopped. Start it, then publish to this URL.';
    default:
      return 'Containers are reported running. Receiving, uploading and playback are not verified.';
  }
}

function uploaderDeployed(profile: ReadinessProfile): boolean {
  return profile.containers.some((c) => c.service === STREAM_UPLOADER_SERVICE);
}

// A pool-backed uploader carries the pool's batches in BEE_PUBLISHERS, so it
// needs no stamp of its own to be deployable.
export function canDeployUploader(profile: ReadinessProfile): boolean {
  return (
    servicesNeedStamp(servicesOf(profile)) &&
    (hasStampId(profile) || hasBeePublishers(profile)) &&
    !uploaderDeployed(profile)
  );
}
