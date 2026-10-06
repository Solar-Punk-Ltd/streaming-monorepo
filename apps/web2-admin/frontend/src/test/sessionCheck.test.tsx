import { act, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequireAuth } from '../components/RequireAuth';
import { LoginPage } from '../pages/LoginPage';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithAuth } from './helpers';

const SESSION = '/api/auth/session';
const ME = '/api/auth/me';
const ENDED = 'Your session ended. Log in again.';

/** The console as the operator sees it: one gated page, and the login page it falls back to. */
function renderConsole() {
  return renderWithAuth(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>streams page</div>} />
      </Route>
    </Routes>,
  );
}

/**
 * How many listeners for `type` are attached to `target` right now, counted
 * from the spies installed before each test. Calls through to the real methods.
 */
type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
const listenerSpies = new Map<
  ListenerTarget,
  { add: { mock: { calls: unknown[][] } }; remove: { mock: { calls: unknown[][] } } }
>();

function spyOnListeners(target: ListenerTarget) {
  listenerSpies.set(target, {
    add: vi.spyOn(target, 'addEventListener'),
    remove: vi.spyOn(target, 'removeEventListener'),
  });
}

function attached(target: ListenerTarget, type: string): number {
  const spies = listenerSpies.get(target);
  if (!spies) throw new Error('listener spies not installed');
  const count = (calls: unknown[][]) => calls.filter(([name]) => name === type).length;
  return count(spies.add.mock.calls) - count(spies.remove.mock.calls);
}

/**
 * The signed-in page is on screen and the provider is listening. The listeners
 * are added by a passive effect after the commit that shows the page, so under
 * load an event fired the moment the text appears can arrive before them.
 */
async function signedInAndListening() {
  await screen.findByText('streams page');
  await vi.waitFor(() => {
    expect(attached(window, 'focus')).toBeGreaterThan(0);
    expect(attached(document, 'visibilitychange')).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  // Restored after each test by `restoreMocks` in the vitest config.
  spyOnListeners(window);
  spyOnListeners(document);
});

/**
 * Signed in on boot; the gated check answers 200 the first time it is asked
 * and 401 from then on, which is what "sign out everywhere" in another browser
 * looks like from this one.
 */
function revokedAfterFirstCheck() {
  let checks = 0;
  return mockFetch([
    { path: SESSION, respond: () => jsonOk({ user: makeUser() }) },
    {
      path: ME,
      respond: () => {
        checks += 1;
        return checks === 1 ? jsonOk({ user: makeUser() }) : jsonError(401, { error: 'unauthenticated' });
      },
    },
  ]);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function becomeVisible() {
  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
}

function regainFocus() {
  fireEvent(window, new Event('focus'));
}

/** Moves the clock past the check's throttle without faking React's timers. */
function laterBy(ms: number) {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + ms);
}

const checksOf = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === ME).length;

describe('the session check when the operator comes back to the tab', () => {
  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    // The getter set above shadows jsdom's own; drop it so other files see jsdom's.
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it('sends a tab that becomes visible to the login page once the session was revoked elsewhere', async () => {
    const fetchMock = revokedAfterFirstCheck();
    renderConsole();
    await signedInAndListening();

    await act(async () => becomeVisible());
    // Still alive: the first check answered 200 and the page stays.
    await vi.waitFor(() => expect(checksOf(fetchMock)).toBe(1));
    expect(screen.getByText('streams page')).toBeInTheDocument();

    laterBy(60_000);
    await act(async () => becomeVisible());

    expect(await screen.findByText(ENDED)).toBeInTheDocument();
    expect(screen.queryByText('streams page')).not.toBeInTheDocument();
  });

  it('sends a window that regains focus to the login page once the session was revoked elsewhere', async () => {
    const fetchMock = revokedAfterFirstCheck();
    renderConsole();
    await signedInAndListening();

    await act(async () => regainFocus());
    await vi.waitFor(() => expect(checksOf(fetchMock)).toBe(1));
    expect(screen.getByText('streams page')).toBeInTheDocument();

    laterBy(60_000);
    await act(async () => regainFocus());

    expect(await screen.findByText(ENDED)).toBeInTheDocument();
    expect(screen.queryByText('streams page')).not.toBeInTheDocument();
  });
});
