/**
 * The readers src/domain/adminLink/adminLinkProbe.ts read the admin's answers with before the contracts package held
 * these shapes, kept as they were so adminLinkReaderParity.test.ts can show the contract reads every answer the same
 * way.
 */

export const UNUSED_STREAM_PATH = '/api/internal/streams/by-ingest/video/00000000-0000-0000-0000-000000000000';

export const STREAM_NOT_FOUND = 'stream_not_found';
export const UNAUTHENTICATED = 'unauthenticated';

export type Answer = { kind: 'none' } | { kind: 'redirect' } | { kind: 'answered'; status: number; body: unknown };

function fieldOf(body: unknown, field: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

export function feedOwnerOf(answer: Answer): string | null {
  if (answer.kind !== 'answered' || answer.status !== 200) return null;
  const owner = fieldOf(fieldOf(answer.body, 'feed'), 'owner');
  return typeof owner === 'string' && owner !== '' ? owner : null;
}

export function sameFeedOwner(left: string, right: string): boolean {
  const normalise = (owner: string) => owner.trim().toLowerCase().replace(/^0x/, '');
  return normalise(left) === normalise(right);
}
