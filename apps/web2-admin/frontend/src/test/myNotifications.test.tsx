import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STARTING_NOTICE_TOPICS, telegramStartLink, type NoticesView } from '@streaming-monorepo/web2-admin-common';

import { formatAgo, formatDateTime } from '../dateUtil';
import { NotificationsPage } from '../pages/NotificationsPage';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';
import {
  makeNoticesView,
  reachOf,
  savedEmailDestination,
  savedEmailService,
  savedTelegramDestination,
  savedTelegramService,
} from './notificationFixtures';

const VIEW = '/api/notifications';
const MY_EMAIL = '/api/notifications/me/destinations/email';
const MY_TELEGRAM = '/api/notifications/me/destinations/telegram';
const TOPICS = '/api/notifications/me/topics';
const CODE = '/api/notifications/me/telegram/code';
const CHAT = '/api/notifications/me/telegram/chat';

const BOT = { username: 'stream_alerts_bot', name: 'Stream alerts' };
const A_CODE = 'K7M2Q9X4TW';
const EXPIRES = '2026-11-26T17:10:00.000Z';

/** Both services saved and on, as a user without the admin role reads them. */
const SERVICES_ON = {
  email: savedEmailService({ settings: null, savedBy: null, savedAt: null }),
  telegram: savedTelegramService({ settings: null, savedBy: null, savedAt: null }),
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

describe('my destinations', () => {
  it('shows how my email address stands: saved, its last notice, its failure, what waits and its last test', async () => {
    serve(() =>
      makeNoticesView({
        managesServices: false,
        services: SERVICES_ON,
        destinations: {
          email: savedEmailDestination({
            lastSentAt: '2026-10-05T08:00:00.000Z',
            lastError: 'Brevo answered with status 400: the address was refused.',
            lastErrorAt: '2026-10-05T09:00:00.000Z',
            waiting: 1,
            lastTestAt: '2026-10-05T07:00:00.000Z',
          }),
        },
      }),
    );
    await openPage();

    const mine = card('My email address');
    expect(mine.getByLabelText('Email address')).toHaveValue('me@example.org');
    expect(mine.getByRole('switch', { name: 'Email address on' })).toBeChecked();
    expect(mine.getByText(`Saved ${formatAgo('2026-10-04T09:00:00.000Z')}.`)).toBeInTheDocument();
    expect(mine.getByText(`Last notice sent ${formatAgo('2026-10-05T08:00:00.000Z')}.`)).toBeInTheDocument();
    expect(
      mine.getByText(
        `The last notice could not be sent ${formatAgo('2026-10-05T09:00:00.000Z')}: Brevo answered with status 400: the address was refused.`,
      ),
    ).toBeInTheDocument();
    expect(mine.getByText('1 notice waits for it.')).toBeInTheDocument();
    expect(mine.getByText(`The last test went out ${formatAgo('2026-10-05T07:00:00.000Z')}.`)).toBeInTheDocument();

    const telegram = card('My Telegram chat');
    expect(telegram.getByText('Not saved yet.')).toBeInTheDocument();
    expect(telegram.getByRole('switch', { name: 'Telegram chat on' })).toBeDisabled();
    expect(telegram.getByRole('button', { name: 'Send me a test notice' })).toBeDisabled();
    expect(telegram.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('checks my address before a save, and saves it behind my password', async () => {
    let view = makeNoticesView({ managesServices: false, services: SERVICES_ON });
    let refuse = true;
    const fetchMock = serve(
      () => view,
      [
        {
          path: MY_EMAIL,
          method: 'PUT',
          respond: () => {
            if (refuse) {
              refuse = false;
              return jsonError(401, { error: 'invalid_credentials', message: 'Wrong password.' });
            }
            view = makeNoticesView({
              managesServices: false,
              services: SERVICES_ON,
              destinations: { email: savedEmailDestination({ savedAt: new Date().toISOString() }) },
              topics: [...STARTING_NOTICE_TOPICS],
            });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    const mine = card('My email address');
    fireEvent.change(mine.getByLabelText('Email address'), { target: { value: 'not an address' } });
    expect(mine.getByText('Enter an email address such as name@example.org.')).toBeInTheDocument();
    expect(mine.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(mine.getByLabelText('Email address'), { target: { value: ' Me@Example.org ' } });
    fireEvent.click(mine.getByRole('button', { name: 'Save' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Save my email address' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(bodiesOf(fetchMock, MY_EMAIL, 'PUT')).toEqual([
      { password: 'wrong', address: 'me@example.org' },
      { password: 'right', address: 'me@example.org' },
    ]);
    expect(card('My email address').getByText('Saved less than a minute ago.')).toBeInTheDocument();
    for (const name of ['Top-ups coming up', 'The brand wallet is low', 'A top-up failed', 'A marked stamp expired']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: 'Stage stamps' })).not.toBeChecked();
  });

  it('switches my destination off and removes it, with no password', async () => {
    let view = makeNoticesView({
      services: SERVICES_ON,
      destinations: { email: savedEmailDestination(), telegram: savedTelegramDestination() },
    });
    const fetchMock = serve(
      () => view,
      [
        {
          path: `${MY_EMAIL}/enabled`,
          method: 'PUT',
          respond: () => {
            view = makeNoticesView({
              services: SERVICES_ON,
              destinations: { email: savedEmailDestination({ enabled: false }), telegram: savedTelegramDestination() },
            });
            return jsonOk(view);
          },
        },
        {
          path: MY_TELEGRAM,
          method: 'DELETE',
          respond: () => {
            view = makeNoticesView({
              services: SERVICES_ON,
              destinations: { email: savedEmailDestination({ enabled: false }) },
            });
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    fireEvent.click(card('My email address').getByRole('switch', { name: 'Email address on' }));
    await waitFor(() =>
      expect(card('My email address').getByRole('switch', { name: 'Email address on' })).not.toBeChecked(),
    );
    expect(bodiesOf(fetchMock, `${MY_EMAIL}/enabled`, 'PUT')).toEqual([{ enabled: false }]);

    fireEvent.click(card('My Telegram chat').getByRole('button', { name: 'Remove' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove my Telegram chat' }));
    expect(dialog.queryByLabelText('Your password')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(card('My Telegram chat').getByText('Not saved yet.')).toBeInTheDocument());
    expect(card('My Telegram chat').getByLabelText('Telegram chat')).toHaveValue('');
    expect(bodiesOf(fetchMock, MY_TELEGRAM, 'DELETE')).toEqual([undefined]);
  });

  it('sends me a test notice and shows the answer, and a second within the minute shows the wait', async () => {
    let view = makeNoticesView({ services: SERVICES_ON, destinations: { email: savedEmailDestination() } });
    let calls = 0;
    serve(
      () => view,
      [
        {
          path: `${MY_EMAIL}/test`,
          method: 'POST',
          respond: () => {
            calls += 1;
            if (calls === 1) {
              view = makeNoticesView({
                services: SERVICES_ON,
                destinations: {
                  email: savedEmailDestination({
                    lastTestAt: new Date().toISOString(),
                    lastTestError: 'Brevo answered with status 400.',
                  }),
                },
              });
              return jsonOk({ sent: false, error: 'Brevo answered with status 400.', view });
            }
            if (calls === 2) return jsonError(429, { error: 'test_too_soon', retryAfterSeconds: 42 });
            view = makeNoticesView({
              services: SERVICES_ON,
              destinations: { email: savedEmailDestination({ lastTestAt: new Date().toISOString() }) },
            });
            return jsonOk({ sent: true, error: null, view });
          },
        },
      ],
    );
    await openPage();

    const mine = card('My email address');
    fireEvent.click(mine.getByRole('button', { name: 'Send me a test notice' }));
    expect(
      await mine.findByText('The test notice could not be sent: Brevo answered with status 400.'),
    ).toBeInTheDocument();
    expect(
      mine.getByText('The last test could not be sent less than a minute ago: Brevo answered with status 400.'),
    ).toBeInTheDocument();

    fireEvent.click(mine.getByRole('button', { name: 'Send me a test notice' }));
    expect(
      await mine.findByText('A test notice went here less than a minute ago. Send another in 42 seconds.'),
    ).toBeInTheDocument();

    fireEvent.click(mine.getByRole('button', { name: 'Send me a test notice' }));
    expect(await mine.findByText('The test notice went out.')).toBeInTheDocument();
    expect(mine.getByText('The last test went out less than a minute ago.')).toBeInTheDocument();
  });

  it('says when the service a destination is on is not set up or is off, and keeps its test off without it', async () => {
    serve(() =>
      makeNoticesView({
        managesServices: false,
        services: { telegram: savedTelegramService({ enabled: false, settings: null }) },
        destinations: { email: savedEmailDestination(), telegram: savedTelegramDestination() },
      }),
    );
    await openPage();

    const email = card('My email address');
    expect(
      email.getByText('The Email service is not set up yet, so nothing goes out here until an admin sets it up.'),
    ).toBeInTheDocument();
    expect(email.getByRole('button', { name: 'Send me a test notice' })).toBeDisabled();
    const telegram = card('My Telegram chat');
    expect(
      telegram.getByText(
        'The Telegram service is switched off, so nothing goes out here until an admin switches it on.',
      ),
    ).toBeInTheDocument();
    expect(telegram.getByRole('button', { name: 'Send me a test notice' })).toBeEnabled();
  });
});

describe('Find my chat', () => {
  it('shows my code, the three ways to send it, and fills in the chat that sent it', async () => {
    let looks = 0;
    const fetchMock = serve(
      () => makeNoticesView({ managesServices: false, services: SERVICES_ON }),
      [
        {
          path: CODE,
          method: 'POST',
          respond: () => jsonOk({ code: A_CODE, expiresAt: EXPIRES, bot: BOT, error: null }),
        },
        {
          path: CHAT,
          method: 'POST',
          respond: () => {
            looks += 1;
            return jsonOk(
              looks === 1
                ? { chat: null, error: null }
                : { chat: { id: '-1001234567890', kind: 'supergroup', name: 'Stream ops' }, error: null },
            );
          },
        },
      ],
    );
    await openPage();

    const telegram = card('My Telegram chat');
    fireEvent.click(telegram.getByRole('button', { name: 'Find my chat' }));
    const sending = within(await telegram.findByRole('group', { name: 'Send your code to the bot' }));
    expect(sending.getByLabelText('Your code')).toHaveValue(A_CODE);
    expect(sending.getByText(new RegExp(`It holds until ${formatDateTime(EXPIRES)}\\.`))).toBeInTheDocument();
    const own = sending.getByRole('link', { name: 'Stream alerts (@stream_alerts_bot)' });
    expect(own).toHaveAttribute('href', telegramStartLink(BOT.username, A_CODE));
    expect(own).toHaveAttribute('target', '_blank');
    expect(sending.getByLabelText('Group command')).toHaveValue(`/start@stream_alerts_bot ${A_CODE}`);
    expect(
      sending.getByText(/send this as one message in the group\. A plain message there stays with the group\./),
    ).toBeInTheDocument();
    expect(sending.getByText(/post the code there\./)).toBeInTheDocument();

    fireEvent.click(sending.getByRole('button', { name: 'I sent it' }));
    expect(await telegram.findByText(/^None of the bot's latest messages holds your code yet\./)).toBeInTheDocument();
    fireEvent.click(sending.getByRole('button', { name: 'I sent it' }));

    expect(
      await telegram.findByText('Found Stream ops · Group · -1001234567890. Save it to have your notices go there.'),
    ).toBeInTheDocument();
    expect(telegram.getByLabelText('Telegram chat')).toHaveValue('-1001234567890');
    expect(telegram.queryByRole('group', { name: 'Send your code to the bot' })).not.toBeInTheDocument();
    expect(telegram.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(bodiesOf(fetchMock, CODE, 'POST')).toEqual([undefined]);
    expect(bodiesOf(fetchMock, CHAT, 'POST')).toEqual([undefined, undefined]);
  });

  it('says when the code is over, and when the bot or Telegram could not be read', async () => {
    let code: { code: string | null; expiresAt: string | null; bot: typeof BOT | null; error: string | null } = {
      code: A_CODE,
      expiresAt: EXPIRES,
      bot: BOT,
      error: null,
    };
    let chat: Route['respond'] = () => jsonError(409, { error: 'code_not_started' });
    serve(
      () => makeNoticesView({ managesServices: false, services: SERVICES_ON }),
      [
        { path: CODE, method: 'POST', respond: () => jsonOk(code) },
        { path: CHAT, method: 'POST', respond: (init) => chat(init) },
      ],
    );
    await openPage();

    const telegram = card('My Telegram chat');
    fireEvent.click(telegram.getByRole('button', { name: 'Find my chat' }));
    fireEvent.click(await telegram.findByRole('button', { name: 'I sent it' }));
    expect(await telegram.findByText('Your code is over. Press Find my chat for a new one.')).toBeInTheDocument();
    expect(telegram.queryByRole('group', { name: 'Send your code to the bot' })).not.toBeInTheDocument();

    chat = () => jsonOk({ chat: null, error: 'Telegram answered with status 502.' });
    fireEvent.click(telegram.getByRole('button', { name: 'Find my chat' }));
    fireEvent.click(await telegram.findByRole('button', { name: 'I sent it' }));
    expect(
      await telegram.findByText('Telegram could not be asked: Telegram answered with status 502.'),
    ).toBeInTheDocument();

    code = { code: null, expiresAt: null, bot: null, error: 'Telegram answered with status 401: Unauthorized.' };
    fireEvent.click(telegram.getByRole('button', { name: 'Find my chat' }));
    expect(
      await telegram.findByText('The bot could not be read: Telegram answered with status 401: Unauthorized.'),
    ).toBeInTheDocument();
    expect(telegram.queryByRole('group', { name: 'Send your code to the bot' })).not.toBeInTheDocument();
  });

  it('stays off until an admin has set up the Telegram service', async () => {
    serve(() => makeNoticesView({ managesServices: false }));
    await openPage();

    const telegram = card('My Telegram chat');
    expect(telegram.getByRole('button', { name: 'Find my chat' })).toBeDisabled();
    expect(telegram.getByText('Find my chat works once an admin has set up the Telegram service.')).toBeInTheDocument();
  });
});

describe('the notices I get', () => {
  it('ticks them in their groups, with how many people get each, saved at once with no password', async () => {
    let view = makeNoticesView({
      services: SERVICES_ON,
      destinations: { email: savedEmailDestination() },
      topics: ['topups_coming', 'topup_failed'],
      reach: reachOf({ topups_coming: 3, topup_failed: 1 }),
    });
    const fetchMock = serve(
      () => view,
      [
        {
          path: TOPICS,
          method: 'PUT',
          respond: (init) => {
            const { topics } = JSON.parse(String(init?.body)) as { topics: NoticesView['topics'] };
            view = { ...view, topics, reach: reachOf({ topups_coming: 3, unmarked_stage: 1 }) };
            return jsonOk(view);
          },
        },
      ],
    );
    await openPage();

    const notices = card('The notices I get');
    const auto = within(notices.getByRole('group', { name: 'Stamp auto top-up' }));
    expect(auto.getByRole('checkbox', { name: 'Top-ups coming up' })).toBeChecked();
    expect(auto.getByRole('checkbox', { name: 'Top-ups coming up' })).toHaveAccessibleDescription(
      'Top-ups of marked stamps, a day ahead. 3 people get it.',
    );
    expect(auto.getByRole('checkbox', { name: 'A top-up failed' })).toHaveAccessibleDescription(
      'A due marked stamp that could not be topped up. 1 person gets it.',
    );
    expect(auto.getByRole('checkbox', { name: 'The brand wallet is low' })).not.toBeChecked();
    const unmarked = within(notices.getByRole('group', { name: 'Stamps not on auto top-up' }));
    expect(unmarked.getByRole('checkbox', { name: 'Stage stamps' })).toHaveAccessibleDescription(
      "A stage's batch, not on auto top-up, running low. Nobody gets it.",
    );

    fireEvent.click(unmarked.getByRole('checkbox', { name: 'Stage stamps' }));
    await waitFor(() => expect(unmarked.getByRole('checkbox', { name: 'Stage stamps' })).toBeChecked());
    fireEvent.click(auto.getByRole('checkbox', { name: 'A top-up failed' }));
    await waitFor(() => expect(auto.getByRole('checkbox', { name: 'A top-up failed' })).not.toBeChecked());

    expect(bodiesOf(fetchMock, TOPICS, 'PUT')).toEqual([
      { topics: ['topups_coming', 'topup_failed', 'unmarked_stage'] },
      { topics: ['topups_coming', 'unmarked_stage'] },
    ]);
    expect(unmarked.getByRole('checkbox', { name: 'Stage stamps' })).toHaveAccessibleDescription(
      "A stage's batch, not on auto top-up, running low. 1 person gets it.",
    );
  });

  it('says my first saved destination ticks the four notices of stamp auto top-up', async () => {
    serve(() => makeNoticesView({ services: SERVICES_ON }));
    await openPage();

    expect(
      screen.getByText(
        'Your first saved email address or Telegram chat ticks the four notices of stamp auto top-up for you.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no notice reaches you now/)).not.toBeInTheDocument();
  });

  it('says when no notice reaches me: none of my destinations is on, on a service that is on', async () => {
    serve(() =>
      makeNoticesView({
        services: SERVICES_ON,
        destinations: { email: savedEmailDestination({ enabled: false }) },
        topics: ['topup_failed'],
      }),
    );
    await openPage();

    expect(
      screen.getByText('None of your destinations is on, on a service that is on, so no notice reaches you now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Your first saved email address/)).not.toBeInTheDocument();
  });
});
