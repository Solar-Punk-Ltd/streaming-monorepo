/**
 * The readers `src/libs/AdminApiClient.ts` and `src/utils/feedOwner.ts` read the admin's answers with before the
 * contracts package held these shapes, kept as they were so adminAnswerParity.test.ts can show the contract reads
 * every answer the same way. `feedOwnerOfConfig` is the reading `fetchFeedOwner` made inline, lifted out whole.
 */
import { MediaType, mediaTypeSchema, Rendition } from '../../src/types.js';

export interface AdminStreamDraft {
  id: string;
  topic: string;
  owner: string;
  mediaType: MediaType;
  title: string;
  status: string;
  publishKey: string;
}

export interface RenditionReportResponse {
  renditions: Rendition[];
  streamStatus: string | null;
  feedIndex: number | null;
  ladder: {
    finished: boolean;
    flippedToFinished: boolean;
    duration: number | null;
  };
}

export function asDraft(body: unknown): AdminStreamDraft | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  const strings = ['id', 'topic', 'owner', 'title', 'status', 'publishKey'] as const;
  for (const field of strings) {
    if (typeof candidate[field] !== 'string' || (candidate[field] as string).length === 0) {
      return null;
    }
  }
  if (!mediaTypeSchema.safeParse(candidate.mediaType).success) {
    return null;
  }
  return candidate as unknown as AdminStreamDraft;
}

export function isRendition(value: unknown): value is Rendition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return false;
  }
  if (typeof candidate.topic !== 'string' || candidate.topic.length === 0) {
    return false;
  }
  for (const field of ['width', 'height', 'bandwidth', 'avgBandwidth'] as const) {
    if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field])) {
      return false;
    }
  }
  if (candidate.index !== undefined) {
    return false;
  }
  const finished = candidate.recording !== undefined;
  if (finished !== (candidate.duration !== undefined)) {
    return false;
  }
  return (
    !finished ||
    (typeof candidate.recording === 'string' &&
      /^[0-9a-f]{64}$/.test(candidate.recording) &&
      typeof candidate.duration === 'number')
  );
}

export function asRenditionReport(body: unknown): RenditionReportResponse | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  if (!Array.isArray(candidate.renditions) || !candidate.renditions.every(isRendition)) {
    return null;
  }
  const ladder = candidate.ladder;
  if (typeof ladder !== 'object' || ladder === null) {
    return null;
  }
  const state = ladder as Record<string, unknown>;
  if (typeof state.finished !== 'boolean' || typeof state.flippedToFinished !== 'boolean') {
    return null;
  }
  if (state.duration !== null && typeof state.duration !== 'number') {
    return null;
  }
  // Optional rather than screened: a body without it is still a ladder, and the caller then falls
  // back to the flip alone, which is what it had before the status was read at all.
  const stream = candidate.stream;
  const status =
    typeof stream === 'object' && stream !== null && typeof (stream as Record<string, unknown>).status === 'string'
      ? ((stream as Record<string, unknown>).status as string)
      : null;
  // Optional for the same reason: an answer without it is taken in arrival order, which is what every
  // answer was before the index was read at all.
  const feed = candidate.feed;
  const feedIndex =
    typeof feed === 'object' &&
    feed !== null &&
    typeof (feed as Record<string, unknown>).index === 'number' &&
    Number.isFinite((feed as Record<string, unknown>).index)
      ? ((feed as Record<string, unknown>).index as number)
      : null;
  return {
    renditions: candidate.renditions as Rendition[],
    streamStatus: status,
    feedIndex,
    ladder: {
      finished: state.finished,
      flippedToFinished: state.flippedToFinished,
      duration: state.duration as number | null,
    },
  };
}

export function feedOwnerOfConfig(body: unknown): string | null {
  const feed = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).feed : undefined;
  const owner = typeof feed === 'object' && feed !== null ? (feed as Record<string, unknown>).owner : undefined;
  if (typeof owner !== 'string' || owner.length === 0) {
    return null;
  }
  return owner;
}

export function sameFeedOwner(left: string, right: string): boolean {
  return normalise(left) === normalise(right);
}

function normalise(owner: string): string {
  return owner.trim().toLowerCase().replace(/^0x/, '');
}

export function lookupPath(streamId: string): string {
  const path = streamId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/internal/streams/by-ingest/${path}`;
}
