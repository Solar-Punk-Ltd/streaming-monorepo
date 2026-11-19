import type {
  PurchasedCatalogueBatches,
  PurchasedRungBatches,
  PurchaseStageApplier,
} from '../funding/purchaseFollowUpPorts.js';
import type { IngestHealthService } from '../ingestHealth/IngestHealthService.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import type { DeploymentSettingsService } from '../settings/DeploymentSettingsService.js';
import type { StampService } from '../StampService.js';

import type { CatalogueDesignationService } from './CatalogueDesignationService.js';
import type { StagePoolStrings } from './StagePoolStrings.js';

/**
 * The parts of the manager that put a batch bought through the funding API to use, behind the three ports of
 * `../funding/purchaseFollowUpPorts.ts`: a rung's batch set as the Buy form sets one, a stage applied as its settings
 * Apply runs, and the catalogue batch designated as a move and released. `docs/features/postage-stamps.md`, "Bought
 * from the admin", is the page.
 */

/** What the three ports are built from: the services the manager's console drives the same parts with. */
export interface PurchaseFollowUpPortsDeps {
  profiles: Pick<ProfileRepository, 'findByName' | 'list'>;
  stamps: Pick<StampService, 'setStamp' | 'stampHealthFor'>;
  poolStrings: Pick<StagePoolStrings, 'followersOf'>;
  settings: Pick<DeploymentSettingsService, 'catalog' | 'apply'>;
  ingest: Pick<IngestHealthService, 'read'>;
  catalogue: Pick<CatalogueDesignationService, 'read' | 'designate' | 'release'>;
  /** Waits between the two readings of whether a broadcast is live: a timer by default, none in the unit tests. */
  pause?: (ms: number) => Promise<void>;
  /** The clock, in ms: `Date.now` by default. */
  now?: () => number;
}

/** The three ports the funding side's purchase follow-up calls. */
export interface PurchaseFollowUpPorts {
  rungs: PurchasedRungBatches;
  stages: PurchaseStageApplier;
  catalogue: PurchasedCatalogueBatches;
}

/** Builds the three ports over the manager's own services. */
export function purchaseFollowUpPorts(deps: PurchaseFollowUpPortsDeps): PurchaseFollowUpPorts {
  void deps;
  const missing = (): Promise<never> => Promise.reject(new Error('Putting a bought batch to use is not built yet.'));
  return {
    rungs: { current: missing, set: missing },
    stages: { look: missing },
    catalogue: { current: missing, designate: missing, release: missing },
  };
}
