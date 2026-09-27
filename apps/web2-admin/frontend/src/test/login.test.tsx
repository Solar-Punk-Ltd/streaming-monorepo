import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { REQUESTED_WITH_HEADER } from '@streaming-monorepo/web2-admin-common';

import { FIRST_USER_COMMAND, FIRST_USER_HINT } from '../authMessages';
import { LoginPage } from '../pages/LoginPage';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithAuth } from './helpers';

const SESSION = '/api/auth/session';
const LOGIN = '/api/auth/login';

/** The boot probe's answer when nobody is signed in and users do exist. */
const signedOut = () => jsonError(401, { error: 'unauthenticated' });

async function fillAndSubmit(username: string, password: string) {
  fireEvent.change(await screen.findByLabelText('Username'), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('LoginPage', () => {
  it('shows the API error when the credentials are wrong', async () => {
    mockFetch([
      { path: SESSION, respond: signedOut },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => jsonError(401, { error: 'invalid_credentials' }),
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'wrong');

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
  });

  it('reads the lockout from the body and says how long to wait', async () => {
    mockFetch([
      { path: SESSION, respond: signedOut },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => jsonError(429, { error: 'too_many_attempts', retryAfterSeconds: 240 }, { 'retry-after': '240' }),
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'admin12345678');

    expect(await screen.findByText('Too many attempts. Try again in 4 minutes.')).toBeInTheDocument();
  });

  it('falls back to the Retry-After header, which is all nginx sends', async () => {
    mockFetch([
      { path: SESSION, respond: signedOut },
      {
        method: 'POST',
        path: LOGIN,
        // nginx's own limit_req answers 429 with an HTML body, not JSON.
        respond: () =>
          ({
            ok: false,
            status: 429,
            headers: { get: () => '120' } as unknown as Headers,
            json: async () => {
              throw new Error('not json');
            },
          }) as unknown as Response,
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'admin12345678');

    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeInTheDocument();
  });

  it('tells the operator how to create the first user when there are none', async () => {
    mockFetch([{ path: SESSION, respond: () => jsonError(401, { error: 'no_users' }) }]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    expect(await screen.findByText('No users yet. Create the first one on the host.')).toBeInTheDocument();
    expect(screen.getByLabelText('Command')).toHaveValue(FIRST_USER_COMMAND);
    // The form that works from any directory, on a server profile and on the
    // dev stack alike, with the names to put in it and how to find them.
    expect(FIRST_USER_COMMAND).toBe('docker exec -it <api-container> node dist/cli.js user:add <username>');
    expect(screen.getByText(FIRST_USER_HINT)).toBeInTheDocument();
    expect(FIRST_USER_HINT).toContain('web2-admin-<profile>-api-1');
    expect(FIRST_USER_HINT).toContain('web2-admin-api-1');
    expect(FIRST_USER_HINT).toContain('docker ps');
  });

  it('says nothing about a session when there never was one', async () => {
    mockFetch([{ path: SESSION, respond: signedOut }]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await screen.findByLabelText('Username');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the server did not answer when the probe never got through', async () => {
    mockFetch([
      {
        path: SESSION,
        respond: () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    expect(
      await screen.findByText('The server did not answer. Check that it is running, then try again.'),
    ).toBeInTheDocument();
  });

  it('keeps the log in button disabled until both fields are filled', async () => {
    mockFetch([{ path: SESSION, respond: signedOut }]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    const button = await screen.findByRole('button', { name: 'Log in' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'admin' },
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'admin12345678' },
    });
    expect(button).toBeEnabled();
  });

  it('sends the cross-site header on the login write', async () => {
    const user = makeUser();
    const fetchMock = mockFetch([
      { path: SESSION, respond: signedOut },
      { method: 'POST', path: LOGIN, respond: () => jsonOk({ user }) },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });
    await fillAndSubmit('admin', 'admin12345678');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        LOGIN,
        expect.objectContaining({
          headers: expect.objectContaining({
            [REQUESTED_WITH_HEADER]: 'web2-admin',
          }),
        }),
      );
    });
  });

  it('clears the error once the login succeeds', async () => {
    const user = makeUser();
    let attempt = 0;
    mockFetch([
      { path: SESSION, respond: signedOut },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => {
          attempt += 1;
          return attempt === 1 ? jsonError(401, { error: 'invalid_credentials' }) : jsonOk({ user });
        },
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'wrong');
    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();

    await fillAndSubmit('admin', 'admin12345678');
    // Logged in: the page redirects, so the form is gone.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
    });
  });
});
