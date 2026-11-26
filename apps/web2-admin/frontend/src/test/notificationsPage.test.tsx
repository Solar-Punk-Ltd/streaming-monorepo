import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route as Path, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationsView } from '@streaming-monorepo/web2-admin-common';

import { AppShell } from '../components/AppShell';
import { formatAgo } from '../dateUtil';
import { NotificationsPage } from '../pages/NotificationsPage';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithProviders, type Route } from './helpers';
import { makeNotificationsView, savedEmail, savedTelegram, unsavedChannel } from './notificationFixtures';

vi.mock('../auth', () => ({ useAuth: () => ({ user: makeUser({ username: 'ada' }), logOut: vi.fn() }) }));
vi.mock('../components/BuildVersion', () => ({ BuildVersion: () => null }));

const VIEW = '/api/notifications';
const EMAIL = '/api/notifications/channels/email';
const SLACK = '/api/notifications/channels/slack';
const TELEGRAM = '/api/notifications/channels/telegram';
const TELEGRAM_CHATS = '/api/notifications/channels/telegram/chats';

const API_KEY = 'xkeysib-0123456789abcdef0123456789abcdef';
const BOT_TOKEN = `1234567890:${'A'.repeat(35)}`;
const WEBHOOK = 'https://hooks.slack.com/services/T0000/B0000/abcdefghij';
const UNAVAILABLE =
  "No channel can be saved: the admin has no BRAND_WALLET_SECRET to seal a channel's secret under. Set it on the admin's host and restart the admin.";

/** The page's view from a getter a test can change, and the writes a test answers. */
function serve(view: () => NotificationsView, writes: Route[] = []) {
  return mockFetch([{ path: VIEW, respond: () => jsonOk(view()) }, ...writes]);
}

/** The bodies the page sent to `path` with `method`, in order. */
const bodiesOf = (fetchMock: ReturnType<typeof mockFetch>, path: string, method: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === method)
    .map(([, init]) => (init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown)));

async function openPage() {
  renderWithProviders(<NotificationsPage />);
  await screen.findByRole('heading', { name: 'Email' });
}

const card = (name: string) => within(screen.getByRole('heading', { name }).closest('[data-section]') as HTMLElement);
const type = (where: ReturnType<typeof card>, name: string, value: string) =>
  fireEvent.change(where.getByLabelText(name), { target: { value } });

describe('the Notifications page', () => {
  it('is in the menu, and shows a card for email, Slack and Telegram', async () => {
    mockFetch([
      { path: '/api/config', respond: () => jsonOk({ feed: null, viewerBaseUrl: null, defaultTheme: 'swarm' }) },
      { path: VIEW, respond: () => jsonOk(makeNotificationsView()) },
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
    expect(await screen.findByRole('heading', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeInTheDocument();
  });

  it('shows how a saved channel stands: on, who saved it, its last notice, its failure, what waits and its test', async () => {
    serve(() =>
      makeNotificationsView({
        email: savedEmail({
          lastSentAt: '2026-10-05T08:00:00.000Z',
          lastError: 'Brevo answered 401: Key not found.',
          lastErrorAt: '2026-10-05T09:00:00.000Z',
          waiting: 2,
          lastTestAt: '2026-10-05T07:00:00.000Z',
        }),
      }),
    );
    await openPage();

    const email = card('Email');
    expect(email.getByRole('switch', { name: 'Email on' })).toBeChecked();
    expect(email.getByText(`Saved by operator, ${formatAgo('2026-10-04T08:00:00.000Z')}.`)).toBeInTheDocument();
    expect(email.getByText(`Last notice sent ${formatAgo('2026-10-05T08:00:00.000Z')}.`)).toBeInTheDocument();
    expect(
      email.getByText(
        `The last notice could not be sent ${formatAgo('2026-10-05T09:00:00.000Z')}: Brevo answered 401: Key not found.`,
      ),
    ).toBeInTheDocument();
    expect(email.getByText('2 notices wait for this channel.')).toBeInTheDocument();
    expect(email.getByText(`The last test went out ${formatAgo('2026-10-05T07:00:00.000Z')}.`)).toBeInTheDocument();
    expect(email.getByLabelText('Sender address')).toHaveValue('alerts@example.org');
    expect(email.getByLabelText('Sender name')).toHaveValue('Stream Admin');
    expect(email.getByLabelText('Recipient 1')).toHaveValue('ops@example.org');

    const slack = card('Slack');
    expect(slack.getByText('Not saved yet.')).toBeInTheDocument();
    expect(slack.getByRole('switch', { name: 'Slack on' })).toBeDisabled();
    expect(slack.getByRole('button', { name: 'Send a test notice' })).toBeDisabled();
    expect(slack.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('never shows a secret: it says set or not set, and the field starts empty', async () => {
    serve(() => makeNotificationsView({ email: savedEmail() }));
    await openPage();

    const email = card('Email');
    expect(email.getByLabelText('API key')).toHaveValue('');
    expect(email.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(email.getByText('Set. Leave the field empty to keep it.')).toBeInTheDocument();
    expect(card('Slack').getByText('Not set.')).toBeInTheDocument();
    expect(card('Slack').getByLabelText('Webhook URL')).toHaveValue('');
  });

  it("checks the form with the package's rules before a save", async () => {
    serve(() => makeNotificationsView());
    await openPage();

    const email = card('Email');
    type(email, 'Sender address', 'not an address');
    expect(email.getByText('The sender address: Enter an email address such as name@example.org.')).toBeInTheDocument();
    type(email, 'Recipient 1', 'ops@example.org');
    fireEvent.click(email.getByRole('button', { name: 'Add recipient' }));
    type(email, 'Recipient 2', ' OPS@example.org ');
    expect(email.getByText('ops@example.org is on the list twice.')).toBeInTheDocument();
    expect(email.getByText('Enter the API key.')).toBeInTheDocument();
    type(email, 'API key', 'short');
    expect(
      email.getByText('Enter the API key the email service gave: one line of 20 characters or more, with no space.'),
    ).toBeInTheDocument();
    expect(email.getByRole('button', { name: 'Save' })).toBeDisabled();

    const telegram = card('Telegram');
    type(telegram, 'Chat id', 'my group');
    expect(
      telegram.getByText(
        "The chat id is a whole number, such as -1001234567890 for a group, or a public channel's name, such as @channelname.",
      ),
    ).toBeInTheDocument();
    type(telegram, 'Bot token', 'nope');
    expect(
      telegram.getByText("Enter the bot's token as BotFather gave it: the bot's number, a colon, and its key."),
    ).toBeInTheDocument();

    const slack = card('Slack');
    type(slack, 'Webhook URL', 'https://example.org/services/a/b/c');
    expect(
      slack.getByText(
        "Enter an incoming webhook's URL from Slack: https://hooks.slack.com/services/ and its three parts.",
      ),
    ).toBeInTheDocument();
    expect(slack.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a channel behind the password, and answers a wrong password', async () => {
    let view = makeNotificationsView();
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
            view = makeNotificationsView({
              email: savedEmail({
                settings: {
                  provider: 'brevo',
                  senderAddress: 'alerts@example.org',
                  senderName: 'Alerts',
                  recipients: ['ops@example.org', 'finance@example.org'],
                },
                savedAt: new Date().toISOString(),
              }),
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
    type(email, 'Recipient 1', 'ops@example.org');
    fireEvent.click(email.getByRole('button', { name: 'Add recipient' }));
    type(email, 'Recipient 2', 'Finance@Example.org');
    type(email, 'API key', ` ${API_KEY} `);
    fireEvent.click(email.getByRole('button', { name: 'Save' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Save the Email channel' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const settings = {
      provider: 'brevo',
      senderAddress: 'alerts@example.org',
      senderName: 'Alerts',
      recipients: ['ops@example.org', 'finance@example.org'],
    };
    expect(bodiesOf(fetchMock, EMAIL, 'PUT')).toEqual([
      { password: 'wrong', settings, secret: API_KEY },
      { password: 'right', settings, secret: API_KEY },
    ]);
    expect(card('Email').getByRole('switch', { name: 'Email on' })).toBeChecked();
    expect(card('Email').getByLabelText('API key')).toHaveValue('');
    expect(card('Email').getByText('Saved by operator, less than a minute ago.')).toBeInTheDocument();
  });

  it('keeps the stored secret when its field is left empty', async () => {
    let view = makeNotificationsView({ telegram: savedTelegram() });
    const fetchMock = serve(
      () => view,
      [
        {
          path: TELEGRAM,
          method: 'PUT',
          respond: () => {
            view = makeNotificationsView({ telegram: savedTelegram({ settings: { chatId: '@streamalerts' } }) });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    const telegram = card('Telegram');
    expect(telegram.getByLabelText('Chat id')).toHaveValue('-1001234567890');
    type(telegram, 'Chat id', '@streamalerts');
    fireEvent.click(telegram.getByRole('button', { name: 'Save' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Save the Telegram channel' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(bodiesOf(fetchMock, TELEGRAM, 'PUT')).toEqual([
      { password: 'right', settings: { chatId: '@streamalerts' }, secret: null },
    ]);
    expect(card('Telegram').getByLabelText('Chat id')).toHaveValue('@streamalerts');
  });

  it('switches a channel off and removes one, with no password', async () => {
    let view = makeNotificationsView({ email: savedEmail(), telegram: savedTelegram() });
    const fetchMock = serve(
      () => view,
      [
        {
          path: `${EMAIL}/enabled`,
          method: 'PUT',
          respond: () => {
            view = makeNotificationsView({ email: savedEmail({ enabled: false }), telegram: savedTelegram() });
            return jsonOk(view);
          },
        },
        {
          path: TELEGRAM,
          method: 'DELETE',
          respond: () => {
            view = makeNotificationsView({ email: savedEmail({ enabled: false }) });
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
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove the Telegram channel' }));
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(card('Telegram').getByText('Not saved yet.')).toBeInTheDocument());
    expect(card('Telegram').getByLabelText('Chat id')).toHaveValue('');
    expect(bodiesOf(fetchMock, TELEGRAM, 'DELETE')).toEqual([undefined]);
  });

  it('sends a test notice and shows the answer, and a second within the minute shows the wait', async () => {
    let view = makeNotificationsView({ email: savedEmail() });
    let calls = 0;
    serve(
      () => view,
      [
        {
          path: `${EMAIL}/test`,
          method: 'POST',
          respond: () => {
            calls += 1;
            if (calls === 1) {
              view = makeNotificationsView({
                email: savedEmail({ lastTestAt: new Date().toISOString(), lastTestError: 'Brevo answered 400.' }),
              });
              return jsonOk({ sent: false, error: 'Brevo answered 400.', view });
            }
            if (calls === 2) {
              return jsonError(429, { error: 'test_too_soon', retryAfterSeconds: 42 });
            }
            view = makeNotificationsView({ email: savedEmail({ lastTestAt: new Date().toISOString() }) });
            return jsonOk({ sent: true, error: null, view });
          },
        },
      ],
    );
    await openPage();

    const email = card('Email');
    fireEvent.click(email.getByRole('button', { name: 'Send a test notice' }));
    expect(await email.findByText('The test notice could not be sent: Brevo answered 400.')).toBeInTheDocument();
    expect(
      email.getByText('The last test could not be sent less than a minute ago: Brevo answered 400.'),
    ).toBeInTheDocument();

    fireEvent.click(email.getByRole('button', { name: 'Send a test notice' }));
    expect(
      await email.findByText(
        'A test notice went out on this channel less than a minute ago. Send another in 42 seconds.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(email.getByRole('button', { name: 'Send a test notice' }));
    expect(await email.findByText('The test notice went out.')).toBeInTheDocument();
    expect(email.getByText('The last test went out less than a minute ago.')).toBeInTheDocument();
  });

  it('shows and hides how to set each channel up from the ? beside its name', async () => {
    serve(() => makeNotificationsView());
    await openPage();

    const setups = [
      { name: 'Email', step: 'xkeysib-', link: 'Brevo', href: 'https://app.brevo.com' },
      {
        name: 'Slack',
        step: 'https://hooks.slack.com/services/',
        link: 'api.slack.com/apps',
        href: 'https://api.slack.com/apps',
      },
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
      const outside = within(setup).getByRole('link', { name: link });
      expect(outside).toHaveAttribute('href', href);
      expect(outside).toHaveAttribute('target', '_blank');
      expect(outside).toHaveAttribute('rel', 'noopener noreferrer');

      fireEvent.click(help);
      expect(help).toHaveAttribute('aria-expanded', 'false');
      expect(where.queryByRole('region', { name: `How to set up ${name}` })).not.toBeInTheDocument();
    }
  });

  it("asks for Telegram's bot token above its chat id", async () => {
    serve(() => makeNotificationsView());
    await openPage();

    const telegram = card('Telegram');
    const token = telegram.getByLabelText('Bot token');
    const chatId = telegram.getByLabelText('Chat id');
    expect(token.compareDocumentPosition(chatId) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('finds the chat id with the token typed, and fills in the chat picked', async () => {
    const fetchMock = serve(
      () => makeNotificationsView(),
      [
        {
          path: TELEGRAM_CHATS,
          method: 'POST',
          respond: () =>
            jsonOk({
              chats: [
                { id: '111111111', kind: 'private', name: 'Ada Lovelace (@ada)' },
                { id: '-1001234567890', kind: 'supergroup', name: 'Stream ops' },
              ],
              error: null,
            }),
        },
      ],
    );
    await openPage();

    const telegram = card('Telegram');
    expect(telegram.getByRole('button', { name: 'Find chat id' })).toBeDisabled();
    expect(
      telegram.getByText('Enter the bot token, then Find chat id lists the chats that wrote to the bot.'),
    ).toBeInTheDocument();
    type(telegram, 'Bot token', ` ${BOT_TOKEN} `);
    fireEvent.click(telegram.getByRole('button', { name: 'Find chat id' }));

    const chats = within(await telegram.findByRole('group', { name: /Chats that wrote to the bot/ }));
    expect(chats.getByRole('button', { name: 'Ada Lovelace (@ada) · Private chat · 111111111' })).toBeInTheDocument();
    fireEvent.click(chats.getByRole('button', { name: 'Stream ops · Group · -1001234567890' }));

    expect(telegram.getByLabelText('Chat id')).toHaveValue('-1001234567890');
    expect(telegram.queryByRole('group', { name: /Chats that wrote to the bot/ })).not.toBeInTheDocument();
    expect(telegram.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(bodiesOf(fetchMock, TELEGRAM_CHATS, 'POST')).toEqual([{ secret: BOT_TOKEN }]);
  });

  it('finds the chat id with the saved token, and says when no chat wrote to the bot or Telegram refused', async () => {
    let answer: { chats: unknown[]; error: string | null } = { chats: [], error: null };
    const fetchMock = serve(
      () => makeNotificationsView({ telegram: savedTelegram() }),
      [{ path: TELEGRAM_CHATS, method: 'POST', respond: () => jsonOk(answer) }],
    );
    await openPage();

    const telegram = card('Telegram');
    fireEvent.click(telegram.getByRole('button', { name: 'Find chat id' }));
    expect(await telegram.findByText(/^No chat wrote to the bot in the last day\./)).toBeInTheDocument();

    answer = { chats: [], error: 'Telegram answered with status 401: Unauthorized.' };
    fireEvent.click(telegram.getByRole('button', { name: 'Find chat id' }));
    expect(
      await telegram.findByText("The bot's chats could not be read: Telegram answered with status 401: Unauthorized."),
    ).toBeInTheDocument();
    expect(telegram.getByLabelText('Chat id')).toHaveValue('-1001234567890');
    expect(bodiesOf(fetchMock, TELEGRAM_CHATS, 'POST')).toEqual([{ secret: null }, { secret: null }]);
  });

  it('says channels cannot be saved while the admin has no BRAND_WALLET_SECRET', async () => {
    serve(() => makeNotificationsView({}, false));
    await openPage();

    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    const slack = card('Slack');
    type(slack, 'Webhook URL', WEBHOOK);
    expect(slack.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says a save refused as notifications_unavailable', async () => {
    const fetchMock = serve(
      () => makeNotificationsView(),
      [
        {
          path: SLACK,
          method: 'PUT',
          respond: () => jsonError(409, { error: 'notifications_unavailable', message: 'No secret to seal under.' }),
        },
      ],
    );
    await openPage();

    const slack = card('Slack');
    type(slack, 'Webhook URL', WEBHOOK);
    fireEvent.click(slack.getByRole('button', { name: 'Save' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Save the Slack channel' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(bodiesOf(fetchMock, SLACK, 'PUT')).toEqual([{ password: 'right', settings: {}, secret: WEBHOOK }]);
  });

  it('says why the view could not be read, with Retry', async () => {
    let fail = true;
    mockFetch([
      {
        path: VIEW,
        respond: () =>
          fail
            ? jsonError(500, { error: 'internal', message: 'The database did not answer.' })
            : jsonOk(makeNotificationsView({ slack: unsavedChannel('slack') })),
      },
    ]);
    renderWithProviders(<NotificationsPage />);

    expect(
      await screen.findByText('The notification channels could not be read: The database did not answer.'),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Slack' })).toBeInTheDocument();
  });
});
