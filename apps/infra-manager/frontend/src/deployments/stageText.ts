import {
  ingestHostProblem,
  isLoopbackIngestHost,
  isStageKind,
  resolvedIngestHost,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';

/**
 * What the deployment page says about a stage: a deployment that runs a
 * stream uploader, whose record the manager pushes into the web2 admin.
 */

/** Whether the page shows the stage card: an ABR uploader or a streamer. */
export function isStage(profile: Pick<Profile, 'kind'>): boolean {
  return isStageKind(profile.kind);
}

/** The address encoders dial, and where it comes from, as the card shows it. */
export interface IngestHostView {
  address: string;
  /** Whether the deployment stores an address of its own. */
  own: boolean;
  source: string;
}

export function ingestHostView(profile: Profile, serverHost: string): IngestHostView {
  const own = Boolean(profile.ingest_host?.trim());
  const address = resolvedIngestHost(profile, serverHost);
  return {
    address,
    own,
    source: isLoopbackIngestHost(address)
      ? 'This address reaches this host alone, so the manager does not push the stage. Set one encoders reach, or PUBLIC_HOST on the manager.'
      : own
        ? 'Set for this deployment.'
        : 'The host the manager resolved for this deployment. Set one when encoders reach it at another address.',
  };
}

/** Why the typed address cannot be saved, or null. An empty one clears the setting. */
export function ingestHostDraftProblem(draft: string): string | null {
  return draft.trim() === '' ? null : ingestHostProblem(draft.trim());
}

/** What a save of the typed address sends: the address, or null to go back to the resolved one. */
export function ingestHostToSave(draft: string): string | null {
  const value = draft.trim();
  return value === '' ? null : value;
}
