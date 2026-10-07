import { act, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { VersionInfo } from '@streaming-monorepo/web2-admin-common';

import { RequireAuth } from '../components/RequireAuth';
import { versionText } from '../format';
import { LoginPage } from '../pages/LoginPage';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithAuth, type Route as MockRoute } from './helpers';

const SESSION = '/api/auth/session';
const LOGIN = '/api/auth/login';
const VERSION = '/api/version';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SHORT = '012345678';

/** A tagged build, as a deploy builds one into the api image. */
const TAGGED: VersionInfo = { label: 'QA-build-2026-10-07', commit: COMMIT };

describe('versionText, the name every console gives a build', () => {
  it('names a tagged build by its tag and its short commit', () => {
    expect(versionText(TAGGED)).toBe(`QA-build-2026-10-07 (${SHORT})`);
  });

  it('names a build past a tag by the tag, how far past it, and its short commit', () => {
    expect(versionText({ label: 'QA-build-2026-10-07+3', commit: COMMIT })).toBe(`QA-build-2026-10-07+3 (${SHORT})`);
  });

  it('names an untagged build with no tag behind it by its short commit once, not twice', () => {
    expect(versionText({ label: SHORT, commit: COMMIT })).toBe(SHORT);
  });

  it('keeps -dirty on a build sent with changes that were not committed', () => {
    expect(versionText({ label: `${SHORT}-dirty`, commit: COMMIT })).toBe(`${SHORT}-dirty`);
    expect(versionText({ label: 'QA-build-2026-10-07+3-dirty', commit: COMMIT })).toBe(
      `QA-build-2026-10-07+3-dirty (${SHORT})`,
    );
    expect(versionText({ label: 'QA-build-2026-10-07-dirty', commit: COMMIT })).toBe(
      `QA-build-2026-10-07-dirty (${SHORT})`,
    );
  });

  it('calls a build with no label a development build, whatever the commit', () => {
    expect(versionText({ label: null, commit: null })).toBe('development build');
    expect(versionText({ label: null, commit: COMMIT })).toBe('development build');
  });

  it('names a label that came without a commit by the label alone', () => {
    expect(versionText({ label: 'QA-build-2026-10-07', commit: null })).toBe('QA-build-2026-10-07');
  });
});

/**
 * The console as the operator meets it: the sign-in page, and two pages behind the route guard. The session probe
 * answers `session`; the version route answers `version`, and every other route is left unmocked.
 */
function renderConsole({
  session = () => jsonOk({ user: makeUser() }),
  version = () => jsonOk(TAGGED),
  extra = [],
}: {
  session?: MockRoute['respond'];
  version?: MockRoute['respond'];
  extra?: MockRoute[];
} = {}) {
  const fetchMock = mockFetch([{ path: SESSION, respond: session }, { path: VERSION, respond: version }, ...extra]);
  renderWithAuth(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>streams page</div>} />
        <Route path="/stages" element={<div>stages page</div>} />
      </Route>
    </Routes>,
  );
  const versionRequests = () => fetchMock.mock.calls.filter(([input]) => String(input) === VERSION).length;
  return { fetchMock, versionRequests };
}

describe('the build line in the signed-in layout', () => {
  it('names the build beside the signed-in account, with the full commit as its title', async () => {
    renderConsole();

    const line = await screen.findByText(`Version QA-build-2026-10-07 (${SHORT})`);

    expect(line).toHaveAttribute('title', COMMIT);
    expect(screen.getByRole('button', { name: 'admin' })).toBeInTheDocument();
  });

  it('says development build when the API carries no version', async () => {
    renderConsole({ version: () => jsonOk({ label: null, commit: null }) });

    const line = await screen.findByText('Version development build');

    expect(line).not.toHaveAttribute('title');
  });

  it('asks once after sign-in, however often the page changes', async () => {
    const { versionRequests } = renderConsole();
    await screen.findByText(`Version QA-build-2026-10-07 (${SHORT})`);

    fireEvent.click(screen.getByRole('button', { name: 'admin' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stages' }));
    await screen.findByText('stages page');

    expect(screen.getByText(`Version QA-build-2026-10-07 (${SHORT})`)).toBeInTheDocument();
    expect(versionRequests()).toBe(1);
  });

  it('shows nothing on the sign-in page, and asks only once someone has signed in', async () => {
    const { versionRequests } = renderConsole({
      session: () => jsonError(401, { error: 'unauthenticated' }),
      extra: [{ method: 'POST', path: LOGIN, respond: () => jsonOk({ user: makeUser() }) }],
    });

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'admin' } });
    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.queryByText(/development build/)).not.toBeInTheDocument();
    expect(versionRequests()).toBe(0);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText(`Version QA-build-2026-10-07 (${SHORT})`)).toBeInTheDocument();
    expect(versionRequests()).toBe(1);
  });

  it('shows no line when the API cannot say, and keeps the page', async () => {
    const { versionRequests } = renderConsole({ version: () => jsonError(404, { error: 'not_found' }) });

    await screen.findByText('streams page');
    await vi.waitFor(() => expect(versionRequests()).toBe(1));
    // The failed answer settles after the request; a line it drew would be on screen by now.
    await act(async () => undefined);

    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.getByText('streams page')).toBeInTheDocument();
  });
});
