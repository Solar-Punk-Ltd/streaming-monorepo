import type { MediaType } from './api.js';

export const MANAGED_LIFECYCLE_VERSION = 1 as const;

export type ManagedLifecycleState =
  | 'ready'
  | 'claimed'
  | 'live'
  | 'waiting'
  | 'closed'
  | 'vod';

export type ManagedRunPermission = 'open' | 'claimed' | 'closed';

export interface ManagedLifecycleSummary {
  version: typeof MANAGED_LIFECYCLE_VERSION;
  revision: number;
  runNumber: number;
  state: ManagedLifecycleState;
}

export interface ImmutableMediaReference {
  topic: string;
  index: number;
  reference: string;
  duration: number;
}

export interface ImmutableRenditionReference extends ImmutableMediaReference {
  name: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  avgBandwidth?: number;
}

export interface CompletedRecordingSnapshot {
  runNumber: number;
  master: ImmutableMediaReference;
  expectedRenditions: string[];
  renditions: ImmutableRenditionReference[];
}

export interface InternalCompletedRecordingSnapshot
  extends CompletedRecordingSnapshot {
  checkpointReference: string;
}

export interface ManagedClaimRequest {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  expectedRevision: number;
  uploaderId: string;
  requestId: string;
}

export interface ManagedRunView {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  streamId: string;
  runNumber: number;
  revision: number;
  uploaderId: string;
  claimId: string | null;
  state: ManagedLifecycleState;
  permission: ManagedRunPermission;
  reconnectDeadline?: string;
  closeReason?: ManagedCloseReason;
  completedRecording?: InternalCompletedRecordingSnapshot;
}

export type ManagedCloseReason =
  | 'reconnect_timeout'
  | 'cancelled'
  | 'recovery_required'
  | 'finalization_failed'
  | 'empty';

interface ManagedReportBase {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  runNumber: number;
  uploaderId: string;
  claimId: string;
  eventSequence: number;
  observedAt: string;
}

export type ManagedRunReport =
  | (ManagedReportBase & { state: 'live' })
  | (ManagedReportBase & {
      state: 'waiting';
      reconnectDeadline: string;
    })
  | (ManagedReportBase & {
      state: 'closed';
      reason: ManagedCloseReason;
      emptyOutcome?: {
        checkpointReference: string;
        acceptedMediaCount: 0;
      };
    })
  | (ManagedReportBase & {
      state: 'vod';
      completedRecording: InternalCompletedRecordingSnapshot;
    });

export type ContinuationOperationState =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'claimed';

export interface ContinuationOperation {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  operationId: string;
  streamId: string;
  topic: string;
  mediaType: MediaType;
  uploaderId: string;
  previousRunNumber: number;
  nextRunNumber: number;
  revision: number;
  status: ContinuationOperationState;
  retainedRecording?: InternalCompletedRecordingSnapshot;
  failure?: string;
}

export interface ContinuationPreparationRequest {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  uploaderId: string;
  expectedRevision: number;
  status: 'ready' | 'failed';
  checkpointReference?: string;
  failure?: string;
}
