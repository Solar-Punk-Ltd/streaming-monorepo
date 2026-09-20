export type ManagedRunState =
  | 'ready'
  | 'claimed'
  | 'live'
  | 'waiting'
  | 'closed'
  | 'vod';

export type ManagedRunPermission = 'open' | 'claimed' | 'closed';

export type ManagedLifecycleConflictCode =
  | 'stale_event'
  | 'event_conflict'
  | 'request_conflict'
  | 'revision_conflict'
  | 'assignment_mismatch'
  | 'candidate_changed'
  | 'managed_route_required'
  | 'stale_run'
  | 'closed';

export class ManagedLifecycleConflict extends Error {
  constructor(public readonly code: ManagedLifecycleConflictCode) {
    super(code);
    this.name = 'ManagedLifecycleConflict';
  }
}

export interface ManagedEventIdentity {
  sequence: number;
  digest: string;
}

export type ManagedEventDisposition = 'accept' | 'duplicate';

export function classifyManagedEvent(
  previous: ManagedEventIdentity | null,
  incoming: ManagedEventIdentity,
): ManagedEventDisposition {
  if (!previous || incoming.sequence > previous.sequence) return 'accept';
  if (incoming.sequence < previous.sequence) {
    throw new ManagedLifecycleConflict('stale_event');
  }
  if (incoming.digest !== previous.digest) {
    throw new ManagedLifecycleConflict('event_conflict');
  }
  return 'duplicate';
}

const RUN_TRANSITIONS: Record<ManagedRunState, readonly ManagedRunState[]> = {
  ready: ['ready', 'claimed', 'closed'],
  claimed: ['claimed', 'live', 'waiting', 'closed'],
  live: ['live', 'waiting', 'closed'],
  waiting: ['waiting', 'live', 'closed'],
  closed: ['closed', 'vod'],
  vod: ['vod'],
};

export function isManagedRunTransitionAllowed(
  from: ManagedRunState,
  to: ManagedRunState,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

const PERMISSION_TRANSITIONS: Record<
  ManagedRunPermission,
  readonly ManagedRunPermission[]
> = {
  open: ['open', 'claimed', 'closed'],
  claimed: ['claimed', 'closed'],
  closed: ['closed'],
};

export function isManagedPermissionTransitionAllowed(
  from: ManagedRunPermission,
  to: ManagedRunPermission,
): boolean {
  return PERMISSION_TRANSITIONS[from].includes(to);
}

export interface ManagedClaimIdentity {
  uploaderId: string;
  claimId: string;
}

export function matchesManagedClaim(
  stored: ManagedClaimIdentity,
  uploaderId: string,
  claimId: string,
): boolean {
  return stored.uploaderId === uploaderId && stored.claimId === claimId;
}
