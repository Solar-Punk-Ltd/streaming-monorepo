import type {
  ChangePasswordRequest,
  IngestDetails,
  LoginRequest,
  MeResponse,
  PublicConfig,
  PublishResult,
  Stream,
  StreamInput,
  StreamListResponse,
} from '@streaming-monorepo/web2-admin-common';

import {
  getJson,
  sendBytes,
  sendDelete,
  sendEmpty,
  sendJson,
} from './http';

const API = '/api';

// --- auth -------------------------------------------------------------------

export function login(body: LoginRequest): Promise<MeResponse> {
  return sendJson<MeResponse>('POST', `${API}/auth/login`, body, {
    expectUnauthorized: true,
  });
}

export function logout(): Promise<void> {
  return sendEmpty(`${API}/auth/logout`);
}

/**
 * The session probe. A 401 here is expected on first load, so it resolves to
 * null instead of throwing and does not trip the global unauthorized handler.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch(`${API}/auth/me`, { credentials: 'same-origin' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`session check failed (${res.status})`);
  return (await res.json()) as MeResponse;
}

export function changePassword(
  body: ChangePasswordRequest,
): Promise<MeResponse> {
  return sendJson<MeResponse>('POST', `${API}/auth/password`, body);
}

// --- streams ----------------------------------------------------------------

export async function fetchStreams(): Promise<Stream[]> {
  const body = await getJson<StreamListResponse>(`${API}/streams`);
  return body.streams;
}

export function fetchStream(id: string): Promise<Stream> {
  return getJson<Stream>(`${API}/streams/${encodeURIComponent(id)}`);
}

export function createStream(input: StreamInput): Promise<Stream> {
  return sendJson<Stream>('POST', `${API}/streams`, input);
}

export function updateStream(
  id: string,
  input: StreamInput,
): Promise<Stream> {
  return sendJson<Stream>(
    'PUT',
    `${API}/streams/${encodeURIComponent(id)}`,
    input,
  );
}

export async function deleteStream(id: string): Promise<void> {
  await sendDelete(`${API}/streams/${encodeURIComponent(id)}`);
}

// --- thumbnail --------------------------------------------------------------

export function uploadThumbnail(id: string, file: File): Promise<Stream> {
  return sendBytes<Stream>(
    `${API}/streams/${encodeURIComponent(id)}/thumbnail`,
    file,
    file.type || 'application/octet-stream',
    { fallback: 'The thumbnail is larger than the 5MB limit.' },
  );
}

export async function deleteThumbnail(id: string): Promise<Stream | null> {
  return sendDelete<Stream>(
    `${API}/streams/${encodeURIComponent(id)}/thumbnail`,
  );
}

/**
 * `updatedAt` busts the browser cache: the URL is stable per stream, so
 * without it a replaced image keeps showing the old bytes.
 */
export function thumbnailUrl(stream: Stream): string {
  return `${API}/streams/${encodeURIComponent(stream.id)}/thumbnail?v=${encodeURIComponent(
    stream.updatedAt,
  )}`;
}

// --- publish ----------------------------------------------------------------

export function publishStream(id: string): Promise<PublishResult> {
  return sendJson<PublishResult>(
    'POST',
    `${API}/streams/${encodeURIComponent(id)}/publish`,
  );
}

export function unpublishStream(id: string): Promise<PublishResult> {
  return sendJson<PublishResult>(
    'POST',
    `${API}/streams/${encodeURIComponent(id)}/unpublish`,
  );
}

// --- ingest -----------------------------------------------------------------

export function fetchIngest(id: string): Promise<IngestDetails> {
  return getJson<IngestDetails>(
    `${API}/streams/${encodeURIComponent(id)}/ingest`,
  );
}

export function rotateIngestKey(id: string): Promise<IngestDetails> {
  return sendJson<IngestDetails>(
    'POST',
    `${API}/streams/${encodeURIComponent(id)}/ingest/rotate-key`,
  );
}

// --- public config ----------------------------------------------------------

export function fetchPublicConfig(): Promise<PublicConfig> {
  return getJson<PublicConfig>(`${API}/config`);
}
