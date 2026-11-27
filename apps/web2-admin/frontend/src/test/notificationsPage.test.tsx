import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route as Path, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { EmailServiceSettings, NoticesView } from '@streaming-monorepo/web2-admin-common';

import { AppShell } from '../components/AppShell';
import { formatAgo } from '../dateUtil';
import { NotificationsPage } from '../pages/NotificationsPage';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithProviders, type Route } from './helpers';
import { makeNoticesView, savedEmailService, savedTelegramService } from './notificationFixtures';

vi.mock('../auth', () => ({ useAuth: () => ({ user: makeUser({ username: 'ada' }), logOut: vi.fn() }) }));
vi.mock('../components/BuildVersion', () => ({ BuildVersion: () => null }));

const VIEW = '/api/notifications';
const EMAIL = '/api/notifications/services/email';
const TELEGRAM = '/api/notifications/services/telegram';

const API_KEY = 'xkeysib-0123456789abcdef0123456789abcdef';
const BOT_TOKEN = `1234567890:${'A'.repeat(35)}`;
const UNAVAILABLE =
  "No service can be saved and no notice sent: the admin has no BRAND_WALLET_SECRET to seal a service's secret under. Set it on the admin's host and restart the admin.";

/** The email service's settings as `savedEmailService` holds them. */
const SAVED_EMAIL_SETTINGS: EmailServiceSettings = {
  provider: 'brevo',
  senderAddress: 'alerts@example.org',
  senderName: 'Stream Admin',
};

/** The page's view from a getter a test can change, and the writes a test answers. */
function serve(view: () => NoticesView, writes: Route[] = []) {
  return mockFetch([{ path: VIEW, respond: () => jsonOk(view()) }, ...writes]);
}

/** The bodies the page sent to `path` with `method`, in order. */
const bodiesOf = (fetchMock: ReturnType<typeof mockFetch>, path: string, method: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === method)
    .map(([, init]) => (init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown)));

async function openPage() {
  renderWithProviders(<NotificationsPage />);
  await screen.findByRole('heading', { name: 'My notifications' });
}

/** A card of the page, by its heading. */
const card = (name: string) =>
  within(screen.getByRole('heading', { name, level: 3 }).closest('[data-section]') as HTMLElement);
const type = (where: ReturnType<typeof card>, name: string, value: string) =>
  fireEvent.change(where.getByLabelText(name), { target: { value } });

describe('the Notifications page', () => {
  it('is in the menu, and shows the shared services and my notifications', async () => {
    mockFetch([
      { path: '/api/config', respond: () => jsonOk({ feed: null, viewerBaseUrl: null, defaultTheme: 'swarm' }) },
      { path: VIEW, respond: () => jsonOk(makeNoticesView()) },
    ]);
    renderWithProviders(
      <AppShell>
        <Routes>
          <Path path="/" element={null} />
          <Path path="/notifications" element={<NotificationsPage />} />
        </Routes>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ada' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Notifications' }));

    expect(await screen.findByRole('heading', { name: 'Notifications', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Shared services', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Email', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Telegram', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My notifications', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My email address', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My Telegram chat', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The notices I get', level: 3 })).toBeInTheDocument();
    expect(screen.queryByText(/Slack/)).not.toBeInTheDocument();
  });
});

describe('the shared services', () => {
  it('shows an admin how a saved service stands, with counts alone of the users', async () => {
    serve(() =>
      makeNoticesView({
        services: {
          email: savedEmailService({
            lastSentAt: '2026-10-05T08:00:00.000Z',
            lastFailure: 'Brevo answered with status 401.',
            lastFailureAt: '2026-10-05T09:00:00.000Z',
            people: 3,
            failing: 1,
            waiting: 2,
          }),
        },
      }),
    );
    await openPage();

    const email = card('Email');
    expect(email.getByRole('switch', { name: 'Email on' })).toBeChecked();
    expect(email.getByText(`Saved by operator, ${formatAgo('2026-10-04T08:00:00.000Z')}.`)).toBeInTheDocument();
    expect(email.getByText(`Last notice sent ${formatAgo('2026-10-05T08:00:00.000Z')}.`)).toBeInTheDocument();
    expect(
      email.getByText(`The latest failure, ${formatAgo('2026-10-05T09:00:00.000Z')}: Brevo answered with status 401.`),
    ).toBeInTheDocument();
    expect(email.getByText('3 destinations on it are on, and 1 of them failed its last notice.')).toBeInTheDocument();
    expect(email.getByText('2 notices wait for its destinations.')).toBeInTheDocument();
    expect(email.getByLabelText('Sender address')).toHaveValue('alerts@example.org');
    expect(email.getByLabelText('Sender name')).toHaveValue('Stream Admin');
    expect(email.queryByLabelText(/Recipient/)).not.toBeInTheDocument();

    const telegram = card('Telegram');
    expect(telegram.getByText('Not saved yet.')).toBeInTheDocument();
    expect(telegram.getByRole('switch', { name: 'Telegram on' })).toBeDisabled();
    expect(telegram.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(telegram.queryByLabelText(/Chat id/)).not.toBeInTheDocument();
    expect(telegram.queryByRole('button', { name: /test notice/ })).not.toBeInTheDocument();
  });

  it('shows every other user only whether each service is set up and on', async () => {
    serve(() =>
      makeNoticesView({
        managesServices: false,
        services: {
          email: savedEmailService({ settings: null, savedBy: null, savedAt: null, people: 3, failing: 1 }),
          telegram: savedTelegramService({ enabled: false, settings: null, savedBy: null, savedAt: null }),
        },
      }),
    );
    await openPage();

    const services = within(screen.getByRole('region', { name: 'Shared services' }));
    expect(services.getByText('Email: on.')).toBeInTheDocument();
    expect(services.getByText('Telegram: set up, switched off.')).toBeInTheDocument();
    expect(
      services.getByText("Every user's notices go out through these services, which an admin sets up."),
    ).toBeInTheDocument();
    expect(services.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(services.queryByRole('switch')).not.toBeInTheDocument();
    expect(services.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(services.queryByText(/destination/)).not.toBeInTheDocument();
    expect(services.queryByText(/operator/)).not.toBeInTheDocument();
  });

  it('never shows a secret: it says set or not set, and the field starts empty', async () => {
    serve(() => makeNoticesView({ services: { email: savedEmailService() } }));
    await openPage();

    const email = card('Email');
    expect(email.getByLabelText('API key')).toHaveValue('');
    expect(email.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(email.getByText('Set. Leave the field empty to keep it.')).toBeInTheDocument();
    expect(card('Telegram').getByText('Not set.')).toBeInTheDocument();
    expect(card('Telegram').getByLabelText('Bot token')).toHaveValue('');
  });

  it("checks the form with the package's rules before a save", async () => {
    serve(() => makeNoticesView());
    await openPage();

    const email = card('Email');
    type(email, 'Sender address', 'not an address');
    expect(email.getByText('The sender address: Enter an email address such as name@example.org.')).toBeInTheDocument();
    expect(email.getByText('Enter the API key.')).toBeInTheDocument();
    type(email, 'API key', 'short');
    expect(
      email.getByText('Enter the API key the email service gave: one line of 20 characters or more, with no space.'),
    ).toBeInTheDocument();
    expect(email.getByRole('button', { name: 'Save' })).toBeDisabled();

    const telegram = card('Telegram');
    type(telegram, 'Bot token', 'nope');
    expect(
      telegram.getByText("Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key."),
    ).toBeInTheDocument();
    expect(telegram.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a service behind the password, and answers a wrong password', async () => {
    let view = makeNoticesView();
    let refuse = true;
    const fetchMock = serve(
      () => view,
      [
        {
          path: EMAIL,
          method: 'PUT',
          respond: () => {
            if (refuse) {
              refuse = false;
              return jsonError(401, { error: 'invalid_credentials', message: 'Wrong password.' });
            }
            view = makeNoticesView({
              services: {
                email: savedEmailService({
                  settings: { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: 'Alerts' },
                  savedAt: new Date().toISOString(),
                }),
              },
            });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    const email = card('Email');
    type(email, 'Sender address', ' Alerts@Example.org ');
    type(email, 'Sender name', 'Alerts');
    type(email, 'API key', ` ${API_KEY} `);
    fireEvent.click(email.getByRole('button', { name: 'Save' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Save the Email service' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const settings = { provider: 'brevo', senderAddress: 'alerts@example.org', senderName: 'Alerts' };
    expect(bodiesOf(fetchMock, EMAIL, 'PUT')).toEqual([
      { password: 'wrong', settings, secret: API_KEY },
      { password: 'right', settings, secret: API_KEY },
    ]);
    expect(card('Email').getByRole('switch', { name: 'Email on' })).toBeChecked();
    expect(card('Email').getByLabelText('API key')).toHaveValue('');
    expect(card('Email').getByText('Saved by operator, less than a minute ago.')).toBeInTheDocument();
  });

  it('saves the Telegram service with its bot token alone, and keeps a stored secret when its field is empty', async () => {
    let view = makeNoticesView({ services: { email: savedEmailService() } });
    const fetchMock = serve(
      () => view,
      [
        {
          path: TELEGRAM,
          method: 'PUT',
          respond: () => {
            view = makeNoticesView({ services: { email: savedEmailService(), telegram: savedTelegramService() } });
            return jsonOk(view);
          },
        },
        {
          path: EMAIL,
          method: 'PUT',
          respond: () => {
            view = makeNoticesView({
              services: {
                email: savedEmailService({ settings: { ...SAVED_EMAIL_SETTINGS, senderName: 'Ops' } }),
                telegram: savedTelegramService(),
              },
            });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    type(card('Telegram'), 'Bot token', BOT_TOKEN);
    fireEvent.click(card('Telegram').getByRole('button', { name: 'Save' }));
    let dialog = within(await screen.findByRole('dialog', { name: 'Save the Telegram service' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(card('Telegram').getByRole('switch', { name: 'Telegram on' })).toBeChecked());

    type(card('Email'), 'Sender name', 'Ops');
    fireEvent.click(card('Email').getByRole('button', { name: 'Save' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Save the Email service' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(bodiesOf(fetchMock, TELEGRAM, 'PUT')).toEqual([{ password: 'right', settings: {}, secret: BOT_TOKEN }]);
    expect(bodiesOf(fetchMock, EMAIL, 'PUT')).toEqual([
      { password: 'right', settings: { ...SAVED_EMAIL_SETTINGS, senderName: 'Ops' }, secret: null },
    ]);
    expect(card('Email').getByLabelText('Sender name')).toHaveValue('Ops');
  });

  it('switches a service off and removes one, with no password', async () => {
    let view = makeNoticesView({ services: { email: savedEmailService(), telegram: savedTelegramService() } });
    const fetchMock = serve(
      () => view,
      [
        {
          path: `${EMAIL}/enabled`,
          method: 'PUT',
          respond: () => {
            view = makeNoticesView({
              services: { email: savedEmailService({ enabled: false }), telegram: savedTelegramService() },
            });
            return jsonOk(view);
          },
        },
        {
          path: TELEGRAM,
          method: 'DELETE',
          respond: () => {
            view = makeNoticesView({ services: { email: savedEmailService({ enabled: false }) } });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    fireEvent.click(card('Email').getByRole('switch', { name: 'Email on' }));
    await waitFor(() => expect(card('Email').getByRole('switch', { name: 'Email on' })).not.toBeChecked());
    expect(bodiesOf(fetchMock, `${EMAIL}/enabled`, 'PUT')).toEqual([{ enabled: false }]);

    fireEvent.click(card('Telegram').getByRole('button', { name: 'Remove' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove the Telegram service' }));
    expect(dialog.getByText(/Each user's Telegram chat stays saved\./)).toBeInTheDocument();
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(card('Telegram').getByText('Not saved yet.')).toBeInTheDocument());
    expect(bodiesOf(fetchMock, TELEGRAM, 'DELETE')).toEqual([undefined]);
  });

  it('reads the page again when a switch finds the service removed meanwhile', async () => {
    let view = makeNoticesView({ services: { email: savedEmailService() } });
    serve(
      () => view,
      [
        {
          path: `${EMAIL}/enabled`,
          method: 'PUT',
          respond: () => {
            view = makeNoticesView();
            return jsonError(409, { error: 'service_not_saved' });
          },
        },
      ],
    );
    await openPage();

    fireEvent.click(card('Email').getByRole('switch', { name: 'Email on' }));
    expect(
      await card('Email').findByText('That service is not set up now. The page shows what is there now.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(card('Email').getByText('Not saved yet.')).toBeInTheDocument());
  });

  it('shows and hides how to set each service up from the ? beside its name', async () => {
    serve(() => makeNoticesView());
    await openPage();

    const setups = [
      { name: 'Email', step: 'xkeysib-', link: 'Brevo', href: 'https://app.brevo.com' },
      { name: 'Telegram', step: '/newbot', link: 'BotFather', href: 'https://t.me/BotFather' },
    ];
    for (const { name, step, link, href } of setups) {
      const where = card(name);
      const help = where.getByRole('button', { name: `How to set up ${name}` });
      expect(help).toHaveAttribute('aria-expanded', 'false');
      expect(where.queryByRole('region', { name: `How to set up ${name}` })).not.toBeInTheDocument();

      fireEvent.click(help);
      expect(help).toHaveAttribute('aria-expanded', 'true');
      const setup = where.getByRole('region', { name: `How to set up ${name}` });
      expect(help).toHaveAttribute('aria-controls', setup.id);
      expect(within(setup).getByText(step)).toBeInTheDocument();
      expect(within(setup).getByText(/under My notifications/)).toBeInTheDocument();
      const outside = within(setup).getByRole('link', { name: link });
      expect(outside).toHaveAttribute('href', href);
      expect(outside).toHaveAttribute('target', '_blank');
      expect(outside).toHaveAttribute('rel', 'noopener noreferrer');

      fireEvent.click(help);
      expect(help).toHaveAttribute('aria-expanded', 'false');
      expect(where.queryByRole('region', { name: `How to set up ${name}` })).not.toBeInTheDocument();
    }
  });

  it('says no service can be saved while the admin has no BRAND_WALLET_SECRET', async () => {
    serve(() => makeNoticesView({ available: false }));
    await openPage();

    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    const telegram = card('Telegram');
    type(telegram, 'Bot token', BOT_TOKEN);
    expect(telegram.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says a save refused as notifications_unavailable', async () => {
    const fetchMock = serve(
      () => makeNoticesView(),
      [
        {
          path: TELEGRAM,
          method: 'PUT',
          respond: () => jsonError(409, { error: 'notifications_unavailable', message: 'No secret to seal under.' }),
        },
      ],
    );
    await openPage();

    const telegram = card('Telegram');
    type(telegram, 'Bot token', BOT_TOKEN);
    fireEvent.click(telegram.getByRole('button', { name: 'Save' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Save the Telegram service' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(bodiesOf(fetchMock, TELEGRAM, 'PUT')).toEqual([{ password: 'right', settings: {}, secret: BOT_TOKEN }]);
  });

  it('says why the view could not be read, with Retry', async () => {
    let fail = true;
    mockFetch([
      {
        path: VIEW,
        respond: () =>
          fail
            ? jsonError(500, { error: 'internal', message: 'The database did not answer.' })
            : jsonOk(makeNoticesView()),
      },
    ]);
    renderWithProviders(<NotificationsPage />);

    expect(
      await screen.findByText('The notifications could not be read: The database did not answer.'),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Shared services' })).toBeInTheDocument();
  });
});
