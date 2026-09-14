import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoginPage } from '../pages/LoginPage';
import { jsonError, jsonOk, mockFetch, renderWithAuth } from './helpers';

const ME = '/api/auth/me';
const LOGIN = '/api/auth/login';

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
      { path: ME, respond: () => jsonError(401, { error: 'unauthenticated' }) },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => jsonError(401, { error: 'invalid_credentials' }),
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'wrong');

    expect(
      await screen.findByText('Wrong username or password.'),
    ).toBeInTheDocument();
  });

  it('surfaces the rate limit as its own message', async () => {
    mockFetch([
      { path: ME, respond: () => jsonError(401, { error: 'unauthenticated' }) },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => jsonError(429, { error: 'too_many_attempts' }),
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'admin1234');

    expect(
      await screen.findByText(/Too many login attempts/),
    ).toBeInTheDocument();
  });

  it('keeps the log in button disabled until both fields are filled', async () => {
    mockFetch([
      { path: ME, respond: () => jsonError(401, { error: 'unauthenticated' }) },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    const button = await screen.findByRole('button', { name: 'Log in' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'admin' },
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'admin1234' },
    });
    expect(button).toBeEnabled();
  });

  it('clears the error once the login succeeds', async () => {
    const user = {
      id: 'u1',
      username: 'admin',
      createdAt: '2026-09-11T10:00:00.000Z',
      passwordChangedAt: null,
    };
    let attempt = 0;
    mockFetch([
      { path: ME, respond: () => jsonError(401, { error: 'unauthenticated' }) },
      {
        method: 'POST',
        path: LOGIN,
        respond: () => {
          attempt += 1;
          return attempt === 1
            ? jsonError(401, { error: 'invalid_credentials' })
            : jsonOk({ user });
        },
      },
    ]);

    renderWithAuth(<LoginPage />, { route: '/login' });

    await fillAndSubmit('admin', 'wrong');
    expect(
      await screen.findByText('Wrong username or password.'),
    ).toBeInTheDocument();

    await fillAndSubmit('admin', 'admin1234');
    // Logged in: the page redirects, so the form is gone.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Log in' }),
      ).not.toBeInTheDocument();
    });
  });
});
