import { ThemeProvider, createTheme } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { ReactNode } from 'react';
import type {
  IngestDetails,
  Stream,
  User,
  UserSummary,
} from '@streaming-monorepo/web2-admin-common';

import { AuthProvider } from '../auth';
import { SnackbarProvider } from '../components/Snackbar';

const theme = createTheme({ palette: { mode: 'dark' } });

/**
 * Minimal Response stand-ins. jsdom has no fetch, and the console only ever
 * reads `ok`, `status` and `json()`, so hand-rolled objects keep the mocks
 * obvious and free of environment surprises.
 */
function headersOf(values: Record<string, string> = {}): Headers {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  } as unknown as Headers;
}

export function jsonOk<T>(body: T, status = 200): Response {
  return {
    ok: true,
    status,
    headers: headersOf(),
    json: async () => body,
  } as unknown as Response;
}

export function jsonError(
  status: number,
  body: unknown,
  /** Lower-case names; only the lockout's `retry-after` is read today. */
  headers: Record<string, string> = {},
): Response {
  return {
    ok: false,
    status,
    headers: headersOf(headers),
    json: async () => body,
  } as unknown as Response;
}

export function noContent(): Response {
  return {
    ok: true,
    status: 204,
    json: async () => {
      throw new Error('no body');
    },
  } as unknown as Response;
}

export interface Route {
  method?: string;
  /** Matched against the path with its query string stripped. */
  path: string;
  respond: (init: RequestInit | undefined) => Response | Promise<Response>;
}

/**
 * Installs a `fetch` that answers from `routes`, first match wins. Anything
 * unmatched rejects loudly rather than hanging a test on a pending promise.
 */
export function mockFetch(routes: Route[]) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).split('?')[0];
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes.find(
        (r) => r.path === url && (r.method ?? 'GET').toUpperCase() === method,
      );
      if (!route) throw new Error(`unmocked request: ${method} ${url}`);
      return route.respond(init);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fetch that never settles, for asserting loading states. */
export function pendingFetch() {
  const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderWithProviders(
  ui: ReactNode,
  { route = '/' }: { route?: string } = {},
): RenderResult {
  return render(
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <SnackbarProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </SnackbarProvider>
      </LocalizationProvider>
    </ThemeProvider>,
  );
}

export function renderWithAuth(
  ui: ReactNode,
  { route = '/' }: { route?: string } = {},
): RenderResult {
  return render(
    <ThemeProvider theme={theme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <SnackbarProvider>
          <MemoryRouter initialEntries={[route]}>
            <AuthProvider>{ui}</AuthProvider>
          </MemoryRouter>
        </SnackbarProvider>
      </LocalizationProvider>
    </ThemeProvider>,
  );
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'admin',
    isAdmin: true,
    createdAt: '2026-09-11T10:00:00.000Z',
    passwordChangedAt: null,
    lastLoginAt: '2026-09-18T08:00:00.000Z',
    ...overrides,
  };
}

export function makeUserSummary(
  overrides: Partial<UserSummary> = {},
): UserSummary {
  return {
    id: 'u1',
    username: 'admin',
    isAdmin: true,
    createdAt: '2026-09-11T10:00:00.000Z',
    lastLoginAt: '2026-09-18T08:00:00.000Z',
    sessions: 1,
    ...overrides,
  };
}

let counter = 0;

export function makeStream(overrides: Partial<Stream> = {}): Stream {
  counter += 1;
  const now = '2026-09-11T10:00:00.000Z';
  return {
    id: `stream-${counter}`,
    topic: `0000000${counter}-0000-4000-8000-000000000000`,
    owner: '1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c',
    title: `Stream ${counter}`,
    description: 'A description',
    tags: [],
    mediaType: 'video',
    scheduledStartTime: '2026-10-01T18:00:00.000Z',
    hasThumbnail: false,
    thumbnailRef: null,
    status: 'draft',
    publishedAt: null,
    publishedFeedIndex: null,
    publishError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeIngest(
  overrides: Partial<IngestDetails> = {},
): IngestDetails {
  return {
    streamId: 'video/00000001-0000-4000-8000-000000000000',
    app: 'video',
    stream: '00000001-0000-4000-8000-000000000000',
    publishKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    publishKeyRotatedAt: null,
    srt: {
      url: 'srt://ingest.example.test:10061?streamid=#!::r=video/00000001-0000-4000-8000-000000000000?key=a1b2c3d4e5f60718293a4b5c6d7e8f90,m=publish',
      passphrase: 'server-wide-passphrase',
    },
    rtmp: {
      server: 'rtmp://ingest.example.test:10062/video',
      streamKey:
        '00000001-0000-4000-8000-000000000000?key=a1b2c3d4e5f60718293a4b5c6d7e8f90',
    },
    keyVerified: false,
    ...overrides,
  };
}
