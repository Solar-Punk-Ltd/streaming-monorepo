import type { Profile } from '../../types/index.js';
import type {
  ClaimedRolloutDeploy,
  PreparedRecoveryDeploy,
  PreparedRolloutDeploy,
  RolloutAdmissionProof,
} from './rolloutDeployAdmission.js';

import type {
  EngineConfigOperation,
  EngineConfigOperationKind,
  EngineConfigOperationState,
  RolloutOwnership,
} from './operations.js';

export interface RolloutStarted {
  profile: Profile;
  operation: EngineConfigOperation;
}

/**
 * The rows a config file rollout owns, and the writes that keep ownership
 * explicit. Every write that acts on a rollout is conditional on the
 * operation's state, the deployment instance, the config revision and the
 * intent revision together, and answers null when any of them moved.
 */
export interface EngineConfigOperationRepository {
  captureDeployAdmission(profile: Profile): Promise<RolloutAdmissionProof>;
  beginDeploy(
    input: PreparedRolloutDeploy & {
      kind: Exclude<EngineConfigOperationKind, 'restore-previous'>;
      config: string | null;
    },
  ): Promise<ClaimedRolloutDeploy | null>;
  beginRevertDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null>;
  beginRestorePreviousDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null>;
  findById(id: number): Promise<EngineConfigOperation | null>;
  findOpen(profileInstanceId: string): Promise<EngineConfigOperation | null>;
  listOpen(): Promise<EngineConfigOperation[]>;
  /** For stop and removal: the instance's open operation is over, durably. */
  supersedeOpen(profileInstanceId: string, message: string): Promise<void>;
  /** A state change of the operation alone, conditional on ownership and on `from`. */
  transition(
    ownership: RolloutOwnership,
    from: readonly EngineConfigOperationState[],
    to: EngineConfigOperationState,
    patch?: Partial<
      Pick<
        EngineConfigOperation,
        'message' | 'containerId' | 'containerStartedAt' | 'recreateFinishedAt' | 'watchStartedAt'
      >
    >,
    /** A preparation outcome also requires this active job and DEPLOYING or ERROR. */
    expectedPreparationJobReferenceId?: number,
  ): Promise<EngineConfigOperation | null>;
}
