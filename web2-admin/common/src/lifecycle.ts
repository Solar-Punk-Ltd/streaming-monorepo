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

export interface ManagedOwnerLifecycle extends ManagedLifecycleSummary {
  permission: ManagedRunPermission;
  closeReason?: ManagedCloseReason;
  /** Remaining reconnect window at the response's server receipt time. */
  reconnectRemainingMs?: number;
  /** True only when the current closed run has durable replay or empty proof. */
  canContinue: boolean;
  /** Server receipt time of the latest active-run report. */
  receivedAt?: string;
  /** Age at this response's server, independent of browser clock skew. */
  observationAgeMs?: number;
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
  expectedRenditions: ManagedExpectedRendition[];
  reconnectDeadline?: string;
  closeReason?: ManagedCloseReason;
  lastAcceptedEvent?: {
    sequence: number;
    digest: string;
  };
  completedRecording?: InternalCompletedRecordingSnapshot;
}

export type ManagedCloseReason =
  | 'reconnect_timeout'
  | 'cancelled'
  | 'recovery_required'
  | 'finalization_failed'
  | 'empty'
  | 'adopted';

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

export interface ManagedRenditionReport {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  uploaderId: string;
  claimId: string;
  renditionSequence: number;
  observedAt: string;
  rendition: ManagedExpectedRendition & {
    index?: number;
    duration?: number;
  };
}

export interface ManagedRenditionReportResponse {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  streamId: string;
  runNumber: number;
  revision: number;
  uploaderId: string;
  claimId: string;
  renditionRevision: number;
  renditions: Array<
    ManagedExpectedRendition & {
      index?: number;
      duration?: number;
    }
  >;
  ladder: {
    finished: boolean;
    flippedToFinished: boolean;
    duration: number | null;
  };
}

/** Stable UTF-8 input for the cross-service report SHA256. */
export function canonicalManagedReportJson(report: ManagedRunReport): string {
  return canonicalJson(report);
}

/** Stable UTF-8 input for one run-scoped rendition event SHA256. */
export function canonicalManagedRenditionReportJson(
  report: ManagedRenditionReport,
): string {
  return canonicalJson(report);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('managed report contains a non-JSON value');
  }
  return encoded;
}

export type ContinuationOperationState =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'claimed';

export interface ContinuationCreateRequest {
  requestId: string;
  expectedRevision: number;
}

export interface ContinuationOperation {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  operationId: string;
  requestId: string;
  streamId: string;
  topic: string;
  mediaType: MediaType;
  uploaderId: string;
  previousRunNumber: number;
  nextRunNumber: number;
  revision: number;
  status: ContinuationOperationState;
  retainedRecording?: InternalCompletedRecordingSnapshot;
  previousEmptyOutcome?: {
    runNumber: number;
    checkpointReference: string;
    acceptedMediaCount: 0;
  };
  failure?: string;
}

export type OwnerContinuationOperation = Omit<
  ContinuationOperation,
  'uploaderId' | 'retainedRecording' | 'previousEmptyOutcome'
>;

export interface ContinuationPreparationRequest {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  uploaderId: string;
  expectedRevision: number;
  status: 'ready' | 'failed';
  checkpointReference?: string;
  failure?: string;
}

export interface LegacyRecordingCandidate {
  streamId: string;
  topic: string;
  mediaType: MediaType;
  master: {
    topic: string;
    index: number;
    duration: number;
  };
  renditions: Array<{
    name: string;
    topic: string;
    index: number;
    duration: number;
    width: number;
    height: number;
    bandwidth: number;
    avgBandwidth: number;
  }>;
}

export type LegacyMediaFormatTrack =
  | {
      kind: 'video';
      codec: string;
      profile: string | null;
      level: number | null;
      width: number;
      height: number;
      pixelFormat: string;
      chromaLocation: string | null;
      bitsPerRawSample: number | null;
    }
  | {
      kind: 'audio';
      codec: string;
      profile: string | null;
      sampleRate: number;
      channels: number;
      channelLayout: string;
    };

export interface LegacyMediaFormatFingerprint {
  version: 1;
  container: 'mpegts';
  /** Canonical order preserves duplicate streams instead of treating this as a set. */
  tracks: LegacyMediaFormatTrack[];
}

export interface LegacyAdoptionValidation {
  version: 1;
  mediaReadable: true;
  pendingWrites: 0;
  /** One entry for the source topic, or one per frozen ABR rendition topic. */
  tracks: Array<{
    topic: string;
    formatFingerprint: LegacyMediaFormatFingerprint;
  }>;
}

export type LegacyAdoptionOperationState =
  | 'pending'
  | 'failed'
  | 'cancelled'
  | 'committed';

export interface LegacyAdoptionCreateRequest {
  requestId: string;
  expectedCandidateDigest: string;
}

export interface LegacyAdoptionOperation {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  kind: 'legacy-adoption';
  operationId: string;
  requestId: string;
  streamId: string;
  topic: string;
  mediaType: MediaType;
  uploaderId: string;
  candidateDigest: string;
  revision: number;
  status: LegacyAdoptionOperationState;
  candidate: LegacyRecordingCandidate;
  completedRecording?: InternalCompletedRecordingSnapshot;
  validation?: LegacyAdoptionValidation;
  failure?: string;
}

export type OwnerLegacyAdoptionOperation = Omit<
  LegacyAdoptionOperation,
  'uploaderId' | 'candidate' | 'completedRecording' | 'validation'
>;

export type LegacyAdoptionPreparationRequest =
  | {
      lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
      uploaderId: string;
      expectedRevision: number;
      candidateDigest: string;
      status: 'ready';
      completedRecording: InternalCompletedRecordingSnapshot;
      validation: LegacyAdoptionValidation;
    }
  | {
      lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
      uploaderId: string;
      expectedRevision: number;
      candidateDigest: string;
      status: 'failed';
      failure: string;
    };

/** Stable bytes for the frozen legacy recording compare-and-set token. */
export function canonicalLegacyRecordingCandidateJson(
  candidate: LegacyRecordingCandidate,
): string {
  return canonicalJson({
    ...candidate,
    renditions: [...candidate.renditions].sort((left, right) =>
      left.name === right.name
        ? left.topic.localeCompare(right.topic)
        : left.name.localeCompare(right.name),
    ),
  });
}

export interface UploaderRenditionProfile {
  name: string;
  width: number;
  height: number;
  bandwidth: number;
  avgBandwidth: number;
}

export interface ManagedExpectedRendition extends UploaderRenditionProfile {
  topic: string;
}

/** One configured output shape for a media type. Empty rungs mean passthrough. */
export interface UploaderMediaProfile {
  mediaType: MediaType;
  renditions: UploaderRenditionProfile[];
}

export interface UploaderCapabilities {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  capabilities: {
    durableCheckpointStore: 1;
    legacyRecordingAdoption: 1;
  };
  /** Exactly one profile may be advertised for each media type. */
  profiles: UploaderMediaProfile[];
}

export interface UploaderCapabilityReceipt {
  lifecycleVersion: typeof MANAGED_LIFECYCLE_VERSION;
  uploaderId: string;
  receivedAt: string;
  freshUntil: string;
  profileDigests: Array<{ mediaType: MediaType; digest: string }>;
}

/** Stable profile fingerprint. Rung order is normalized by name. */
export function canonicalUploaderProfileJson(
  profile: UploaderMediaProfile,
): string {
  return canonicalJson({
    ...profile,
    renditions: [...profile.renditions].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  });
}
