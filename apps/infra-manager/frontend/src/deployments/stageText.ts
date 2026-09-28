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

/** The action that takes the uploader's web2 admin token out, on the stage card. */
export const ROTATE_ADMIN_TOKEN_LABEL = "Rotate the uploader's admin token";

/** Said under the action. */
export const ROTATE_ADMIN_TOKEN_NOTE =
  'The next deploy gives the uploader a new token of its own and registers it with the web2 admin before the uploader starts. An uploader on a token the manager did not generate, which the web2 admin refuses, gets one of its own this way and no other.';

/** What the confirmation says before anything is taken out. */
export const ROTATE_ADMIN_TOKEN_BODY =
  "The uploader's current token is taken out, and the web2 admin stops taking it once the manager next pushes this stage. The running uploader then cannot report until the deployment is redeployed, which generates the new token.";
