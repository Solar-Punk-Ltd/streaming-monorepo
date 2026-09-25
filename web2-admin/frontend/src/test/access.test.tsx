import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AccessPage } from '../pages/AccessPage';
import {
  jsonError,
  jsonOk,
  makeUser,
  makeUserSummary,
  mockFetch,
  noContent,
  renderWithAuth,
} from './helpers';

const SESSION = '/api/auth/session';
const USERS = '/api/auth/users';

// Not named "admin": the admin chip carries that word, and a username that
// collides with it makes every row lookup ambiguous. Created at noon built from
// local parts, as in dateUtil.test.ts, so the table shows 12:00 in any zone.
const ADMIN = makeUserSummary({
  id: 'u1',
  username: 'root',
  createdAt: new Date(2026, 8, 11, 12, 0).toISOString(),
  sessions: 2,
});
const KIM = makeUserSummary({
  id: 'u2',
  username: 'kim',
  isAdmin: false,
  lastLoginAt: null,
  sessions: 0,
});

/**
 * Mounts the page with `me` signed in and the given user list. Every other
 * route is left unmocked, so an unexpected call fails the test loudly.
 */
function renderAccess(
  users = [ADMIN, KIM],
  { isAdmin = true, username = 'root' } = {},
  extra: Parameters<typeof mockFetch>[0] = [],
) {
  const fetchMock = mockFetch([
    {
      path: SESSION,
      respond: () => jsonOk({ user: makeUser({ username, isAdmin }) }),
    },
    { path: USERS, respond: () => jsonOk({ users }) },
    ...extra,
  ]);
  renderWithAuth(<AccessPage />, { route: '/access' });
  return fetchMock;
}

/** The reason a greyed-out button gives when the pointer lands on it. */
async function tooltipOf(name: string) {
  const button = await screen.findByRole('button', { name });
  fireEvent.mouseOver(button.parentElement as HTMLElement);
  return (await screen.findByRole('tooltip')).textContent;
}

/** The table row for a user. Scoped to the table: the change-password card
 *  names the signed-in user too. */
function rowOf(username: string) {
  const table = screen.getByRole('table');
  return within(table).getByText(username).closest('tr') as HTMLElement;
}

describe('the users table', () => {
  it('shows each user with their admin badge, dates and open sessions', async () => {
    renderAccess();

    expect(await screen.findByText('kim')).toBeInTheDocument();
    const root = within(rowOf('root'));
    expect(root.getByText('admin')).toBeInTheDocument();
    expect(root.getByText('you')).toBeInTheDocument();
    expect(root.getByText('11/09/2026 12:00')).toBeInTheDocument();
    expect(root.getByText('2')).toBeInTheDocument();

    const kim = within(rowOf('kim'));
    expect(kim.getByText('Never')).toBeInTheDocument();
    expect(kim.queryByText('you')).not.toBeInTheDocument();
  });

  it('refuses to remove your own account, and says why', async () => {
    renderAccess();
    await screen.findByText('kim');

    const own = within(rowOf('root')).getByRole('button', { name: 'Remove' });
    expect(own).toBeDisabled();

    fireEvent.mouseOver(own.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'You cannot remove your own account',
    );
  });

  it('refuses to remove the last admin, which would leave nobody in charge', async () => {
    // Two admins, so removing either leaves one: nothing blocks kim's row.
    renderAccess([
      makeUserSummary({ id: 'u1', username: 'root' }),
      makeUserSummary({ id: 'u2', username: 'kim', isAdmin: true, sessions: 0 }),
    ]);
    await screen.findByText('kim');

    // Two admins: kim can go.
    expect(within(rowOf('kim')).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('names the last admin as the reason when there is only one', async () => {
    renderAccess(
      [
        makeUserSummary({ id: 'u1', username: 'root', isAdmin: true }),
        makeUserSummary({ id: 'u2', username: 'kim', isAdmin: false }),
      ],
      { username: 'kim', isAdmin: true },
    );
    await screen.findByText('root');

    const button = within(rowOf('root')).getByRole('button', { name: 'Remove' });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'This is the last admin',
    );
  });

  it('refuses to remove the last user of all', async () => {
    renderAccess([makeUserSummary({ id: 'u1', username: 'root' })], {
      username: 'kim',
    });
    await screen.findByText('root');

    expect(await tooltipOf('Remove')).toContain('This is the last user');
  });

  it('lets nobody but an admin remove or revoke someone else', async () => {
    renderAccess([ADMIN, KIM], { username: 'kim', isAdmin: false });
    await screen.findByText('root');

    const remove = within(rowOf('root')).getByRole('button', {
      name: 'Remove',
    });
    expect(remove).toBeDisabled();
    fireEvent.mouseOver(remove.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Only an admin can remove a user',
    );

    // And the add form is not there at all.
    expect(screen.queryByText('Add user')).not.toBeInTheDocument();
  });

  it('cannot sign out a user who has no session open', async () => {
    renderAccess();
    await screen.findByText('kim');

    const button = within(rowOf('kim')).getByRole('button', {
      name: 'Sign out everywhere',
    });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'no open sessions',
    );
  });

  it('removes a user once the dialog is confirmed, then reloads the list', async () => {
    let listed = [ADMIN, KIM];
    const fetchMock = mockFetch([
      { path: SESSION, respond: () => jsonOk({ user: makeUser() }) },
      { path: USERS, respond: () => jsonOk({ users: listed }) },
      {
        method: 'DELETE',
        path: '/api/auth/users/u2',
        respond: () => {
          listed = [ADMIN];
          return noContent();
        },
      },
    ]);
    renderWithAuth(<AccessPage />, { route: '/access' });
    await screen.findByText('kim');

    fireEvent.click(
      within(rowOf('kim')).getByRole('button', { name: 'Remove' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.queryByText('kim')).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/users/u2',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('shows the API error with a retry action', async () => {
    mockFetch([
      { path: SESSION, respond: () => jsonOk({ user: makeUser() }) },
      {
        path: USERS,
        respond: () => jsonError(403, { error: 'admin_required' }),
      },
    ]);
    renderWithAuth(<AccessPage />, { route: '/access' });

    expect(await screen.findByText(/Only an admin can do that/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('adding a user', () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('refuses a username the database would refuse, before it is sent', async () => {
    renderAccess();
    await screen.findByText('kim');

    type('Username', 'Not A Username');

    expect(
      await screen.findByText(/username must be 2 to 32 characters/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled();
  });

  it('refuses a password that is too short or carries the username', async () => {
    renderAccess();
    await screen.findByText('kim');

    type('Username', 'kim2');
    type('Password', 'short');
    expect(
      await screen.findByText('password must be at least 12 characters'),
    ).toBeInTheDocument();

    type('Password', 'kim2-is-here-again');
    expect(
      await screen.findByText('password must not contain the username'),
    ).toBeInTheDocument();
  });

  it('refuses two passwords that are not the same', async () => {
    renderAccess();
    await screen.findByText('kim');

    type('Username', 'kim2');
    type('Password', 'a-long-enough-one');
    type('Password again', 'a-long-enough-two');

    expect(
      await screen.findByText('The two passwords are not the same.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled();
  });

  it('posts the username, the password and the admin flag', async () => {
    const fetchMock = renderAccess([ADMIN, KIM], {}, [
      { method: 'POST', path: USERS, respond: () => jsonOk({}, 201) },
    ]);
    await screen.findByText('kim');

    type('Username', 'kim2');
    type('Password', 'a-long-enough-one');
    type('Password again', 'a-long-enough-one');
    fireEvent.click(
      screen.getByLabelText(/Admin: can add and remove users/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        USERS,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            username: 'kim2',
            password: 'a-long-enough-one',
            admin: true,
          }),
        }),
      );
    });
  });
});

describe('changing my own password', () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('says what it will do to the other browsers before it does it', async () => {
    renderAccess();

    expect(
      await screen.findByText(
        'This browser stays signed in. Every other one is signed out.',
      ),
    ).toBeInTheDocument();
  });

  it('holds the new password to the shared rule', async () => {
    renderAccess();
    await screen.findByText('kim');

    type('Current password', 'whatever-it-was');
    type('New password', 'root-is-in-here');

    expect(
      await screen.findByText('password must not contain the username'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Change password' }),
    ).toBeDisabled();
  });

  it('sends the change and keeps this browser signed in', async () => {
    const fetchMock = renderAccess([ADMIN, KIM], {}, [
      {
        method: 'POST',
        path: '/api/auth/password',
        respond: () =>
          jsonOk({
            user: makeUser({ passwordChangedAt: '2026-09-18T09:00:00.000Z' }),
          }),
      },
    ]);
    await screen.findByText('kim');

    type('Current password', 'whatever-it-was');
    type('New password', 'a-long-enough-one');
    type('Repeat new password', 'a-long-enough-one');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(
      await screen.findByText(
        'Password changed. Your other browsers were signed out.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/password',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('says the current password was wrong rather than signing you out', async () => {
    renderAccess([ADMIN, KIM], {}, [
      {
        method: 'POST',
        path: '/api/auth/password',
        respond: () => jsonError(401, { error: 'invalid_credentials' }),
      },
    ]);
    await screen.findByText('kim');

    type('Current password', 'not-the-right-one');
    type('New password', 'a-long-enough-one');
    type('Repeat new password', 'a-long-enough-one');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(
      await screen.findByText('That is not your current password.'),
    ).toBeInTheDocument();
    // Still on the page: a 401 here is an answer, not an eviction.
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });
});
