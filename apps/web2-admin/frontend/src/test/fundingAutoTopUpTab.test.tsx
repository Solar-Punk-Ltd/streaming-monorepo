import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  NOTICE_TOPICS,
  type AutoTopUpUnmarkedStamp,
  type AutoTopUpView,
  type NoticesView,
} from '@streaming-monorepo/web2-admin-common';

import { XDAI_WARNING_EMPTY } from '../components/funding/autoTopUp';
import { formatAgo, formatDateTime } from '../dateUtil';
import { FundingPage } from '../pages/FundingPage';
import { BATCH, makeAutoTopUpView, makeMark, makeView, xbzz } from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';
import {
  makeNoticesView,
  reachOf,
  savedEmailDestination,
  savedEmailService,
  savedTelegramDestination,
  savedTelegramService,
} from './notificationFixtures';

const AUTO = '/api/funding/auto-top-up';
const UNMARKED = '/api/funding/auto-top-up/unmarked';
const NOTICES = '/api/notifications';
const SETTINGS = '/api/funding/auto-top-up/settings';
const JOB_WALLET = '/api/funding/auto-top-up/jobs/wallet';

/** Two people get every topic: the notices view the tab reads unless a test says otherwise. */
const EVERYONE_GETS = makeNoticesView({
  managesServices: false,
  services: {
    email: savedEmailService({ settings: null, savedBy: null, savedAt: null, people: 2 }),
    telegram: savedTelegramService({ settings: null, savedBy: null, savedAt: null }),
  },
  reach: reachOf(Object.fromEntries(NOTICE_TOPICS.map((topic) => [topic, 2]))),
});

/**
 * The Funding view, the Auto top-up view, the notices and the stamps not on auto top-up, from getters a test can
 * change, and the writes a test answers.
 */
function serve(
  auto: () => AutoTopUpView,
  writes: Route[] = [],
  {
    notices = () => EVERYONE_GETS,
    unmarked = () => [],
  }: { notices?: () => NoticesView; unmarked?: () => AutoTopUpUnmarkedStamp[] } = {},
) {
  return mockFetch([
    { path: '/api/funding', respond: () => jsonOk(makeView()) },
    { path: AUTO, respond: () => jsonOk(auto()) },
    { path: NOTICES, respond: () => jsonOk(notices()) },
    { path: UNMARKED, respond: () => jsonOk({ stamps: unmarked() }) },
    ...writes,
  ]);
}

/** A low unmarked stamp: a stage's batch on pool-360p, under 7 days for a day, told of by a notice. */
function makeUnmarked(over: Partial<AutoTopUpUnmarkedStamp> = {}): AutoTopUpUnmarkedStamp {
  return {
    batchId: BATCH.rung,
    nodeId: 'stage-2:360p',
    holder: 'stage',
    level: 'low',
    since: '2026-10-04T10:00:00.000Z',
    levelSince: '2026-10-04T10:00:00.000Z',
    message: 'The batch of pool-360p has 6 days left. Top it up on the Stamps tab, or mark it for auto top-up.',
    notifiedAt: '2026-10-04T10:10:00.000Z',
    ...over,
  };
}

async function openTab() {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Auto top-up' }));
  await screen.findByRole('heading', { name: 'Where things stand' });
}

const section = (name: string) =>
  within(screen.getByRole('heading', { name }).closest('[data-section]') as HTMLElement);
const field = (name: string) => screen.getByRole('textbox', { name });
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });

/** The bodies the page sent to `path` with PUT, in order. */
const bodiesOf = (fetchMock: ReturnType<typeof mockFetch>, path: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

describe('the Auto top-up tab', () => {
  it('is the fourth tab of the Funding page', async () => {
    serve(() => makeAutoTopUpView());
    renderWithProviders(<FundingPage />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Balance',
      'Stamps',
      'Chequebooks',
      'Auto top-up',
    ]);
    await screen.findByText(/^Balances as the manager read them/);
  });

  it('shows the monthly estimate beside the brand wallet, the ceiling in force and what was sent today', async () => {
    serve(() => makeAutoTopUpView({ sentTodayPlur: xbzz('0.25') }));
    await openTab();

    const stand = section('Where things stand');
    await waitFor(() => expect(stand.getByText('Monthly estimate').nextSibling).toHaveTextContent('3.000 xBZZ'));
    expect(stand.getByText('Brand wallet').nextSibling).toHaveTextContent('12.500 xBZZ · 1.500 xDAI');
    expect(stand.getByText('Daily ceiling in force').nextSibling).toHaveTextContent(
      '1.500 xBZZ, half the monthly estimate',
    );
    expect(stand.getByText('Sent in the last 24 hours').nextSibling).toHaveTextContent('0.250 xBZZ');
  });

  it('lists the top-ups coming up and the warnings that stand', async () => {
    serve(() =>
      makeAutoTopUpView({
        stamps: [
          makeMark({
            batchId: BATCH.rung,
            nodeId: 'stage-2:360p',
            nodeLabel: 'pool-360p',
            coming: {
              due: false,
              dueAt: '2026-10-06T08:00:00.000Z',
              days: 7,
              costPlur: xbzz('0.304'),
              costWithMarginPlur: xbzz('0.335'),
              sendPlur: xbzz('0.2'),
              gasSend: true,
              alertedAt: '2026-10-05T08:00:00.000Z',
              sendAt: '2026-10-06T09:00:00.000Z',
            },
          }),
        ],
        warnings: [
          {
            kind: 'wallet_xdai',
            batchId: null,
            since: '2026-10-05T07:00:00.000Z',
            message: 'The brand wallet holds 0.05 xDAI, under the 0.1 xDAI warning.',
            notifiedAt: null,
          },
        ],
      }),
    );
    await openTab();

    const coming = within(await screen.findByRole('table', { name: 'Top-ups coming up' }));
    const row = within(coming.getByText('pool-360p').closest('tr') as HTMLElement);
    expect(row.getByText(formatDateTime('2026-10-06T08:00:00.000Z'))).toBeInTheDocument();
    expect(row.getByText('7 days')).toBeInTheDocument();
    expect(row.getByText('0.304 xBZZ')).toBeInTheDocument();
    expect(row.getByText('0.335 xBZZ')).toBeInTheDocument();
    expect(row.getByText('0.200 xBZZ and gas')).toBeInTheDocument();
    expect(row.getByText(`Alerted ${formatDateTime('2026-10-05T08:00:00.000Z')}`)).toBeInTheDocument();
    expect(row.getByText(`Sent from ${formatDateTime('2026-10-06T09:00:00.000Z')}`)).toBeInTheDocument();
    expect(screen.getByText('The brand wallet holds 0.05 xDAI, under the 0.1 xDAI warning.')).toBeInTheDocument();
    expect(
      screen.getByText(`Since ${formatDateTime('2026-10-05T07:00:00.000Z')}, not notified yet.`),
    ).toBeInTheDocument();
  });

  it('says when nothing is coming up and no warning stands', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();
    expect(await screen.findByText('No top-ups coming up.')).toBeInTheDocument();
    expect(screen.getByText('No warnings.')).toBeInTheDocument();
  });

  it('says beside each notice how many people get it, or that nobody does and it shows here alone', async () => {
    serve(() => makeAutoTopUpView(), [], {
      notices: () => makeNoticesView({ reach: reachOf({ topups_coming: 3, topup_failed: 1 }) }),
    });
    await openTab();

    const notices = section('Notices');
    await waitFor(() =>
      expect(notices.getByText('Top-ups coming up').nextSibling).toHaveTextContent('3 people get it.'),
    );
    expect(notices.getByText('A top-up failed').nextSibling).toHaveTextContent('1 person gets it.');
    expect(notices.getByText('The brand wallet is low').nextSibling).toHaveTextContent('Nobody: it shows here alone.');
    expect(notices.getByRole('heading', { name: 'Stamp auto top-up' })).toBeInTheDocument();
    expect(notices.getByRole('heading', { name: 'Stamps not on auto top-up' })).toBeInTheDocument();
    expect(notices.getByText('Stage stamps').nextSibling).toHaveTextContent('Nobody: it shows here alone.');
    expect(notices.getByRole('link', { name: 'Choose your notices on the Notifications page' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('says how each service stands and how many destinations failed, counts alone, and why mine failed', async () => {
    serve(() => makeAutoTopUpView(), [], {
      notices: () =>
        makeNoticesView({
          managesServices: false,
          services: {
            email: savedEmailService({
              settings: null,
              savedBy: null,
              savedAt: null,
              lastSentAt: '2026-10-04T08:00:00.000Z',
              lastFailure: 'Brevo answered with status 502.',
              lastFailureAt: '2026-10-05T09:50:00.000Z',
              people: 3,
              failing: 2,
            }),
            telegram: savedTelegramService({ enabled: false, settings: null, savedBy: null, savedAt: null }),
          },
          destinations: {
            email: savedEmailDestination({
              lastError: 'Brevo answered with status 400: the address was refused.',
              lastErrorAt: '2026-10-05T09:50:00.000Z',
            }),
            telegram: savedTelegramDestination(),
          },
        }),
    });
    await openTab();

    const notices = section('Notices');
    expect(
      await notices.findByText(
        `Email: on, last took a notice ${formatAgo('2026-10-04T08:00:00.000Z')}. 3 destinations on it are on, and 2 of them failed their last notice.`,
      ),
    ).toBeInTheDocument();
    expect(
      notices.getByText(
        `The latest failure, ${formatAgo('2026-10-05T09:50:00.000Z')}: Brevo answered with status 502.`,
      ),
    ).toBeInTheDocument();
    expect(
      notices.getByText('Telegram: set up, switched off, no notice sent yet. No destination on it is on.'),
    ).toBeInTheDocument();
    expect(
      notices.getByText(
        `The last notice to your email address could not be sent ${formatAgo('2026-10-05T09:50:00.000Z')}: Brevo answered with status 400: the address was refused.`,
      ),
    ).toBeInTheDocument();
    expect(notices.queryByText(/your Telegram chat/)).not.toBeInTheDocument();
  });

  it('says beside a warning that nobody gets its notice, so it shows here alone', async () => {
    serve(
      () =>
        makeAutoTopUpView({
          warnings: [
            {
              kind: 'topup_failed',
              batchId: BATCH.rung,
              since: '2026-10-05T07:00:00.000Z',
              message: 'The batch of pool-360p could not be topped up: its node holds too little xBZZ.',
              notifiedAt: null,
            },
          ],
        }),
      [],
      { notices: () => makeNoticesView() },
    );
    await openTab();

    expect(
      await screen.findByText(
        `Since ${formatDateTime('2026-10-05T07:00:00.000Z')}. Nobody gets "A top-up failed", so it shows here alone.`,
      ),
    ).toBeInTheDocument();
  });

  it('lists the stamps not on auto top-up that are running low', async () => {
    serve(() => makeAutoTopUpView(), [], {
      notices: () => makeNoticesView({ reach: reachOf({ unmarked_stage: 1 }) }),
      unmarked: () => [
        makeUnmarked({
          batchId: BATCH.expired,
          level: 'expired',
          levelSince: '2026-10-05T06:00:00.000Z',
          message: 'The batch of pool-360p has expired. It takes a Buy new on the Stamps tab.',
        }),
        makeUnmarked({
          batchId: BATCH.catalogue,
          nodeId: 'catalogue:bee',
          holder: 'catalogue',
          level: 'last',
          levelSince: '2026-10-05T08:00:00.000Z',
          message: 'The catalogue batch has 1 day left. Top it up on the Stamps tab, or mark it for auto top-up.',
          notifiedAt: null,
        }),
        makeUnmarked({ nodeId: 'stage-9:gone', notifiedAt: null }),
      ],
    });
    await openTab();

    const stand = section('Where things stand');
    const expired = (await stand.findByText(/has expired\. It takes a Buy new/)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(
      within(expired).getByText(
        `Expired since ${formatDateTime('2026-10-05T06:00:00.000Z')}. Notified ${formatDateTime('2026-10-04T10:10:00.000Z')}.`,
      ),
    ).toBeInTheDocument();
    expect(within(expired).getByText(/^Stage stamps · pool-360p ·/)).toBeInTheDocument();

    const last = stand.getByText(/The catalogue batch has 1 day left/).closest('[role="alert"]') as HTMLElement;
    expect(
      within(last).getByText(
        `Under 7 days since ${formatDateTime('2026-10-04T10:00:00.000Z')}, under 2 days since ${formatDateTime('2026-10-05T08:00:00.000Z')}. Nobody gets "Catalogue and archive stamps", so it shows here alone.`,
      ),
    ).toBeInTheDocument();
    expect(within(last).getByText(/^Catalogue and archive stamps · catalogue-node ·/)).toBeInTheDocument();

    const unknown = stand.getByText(/^Stage stamps · stage-9:gone ·/).closest('[role="alert"]') as HTMLElement;
    expect(
      within(unknown).getByText(`Under 7 days since ${formatDateTime('2026-10-04T10:00:00.000Z')}. Not notified yet.`),
    ).toBeInTheDocument();
  });

  it('says when no stamp off auto top-up is running low', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();
    expect(await screen.findByText('No stamp off auto top-up is running low.')).toBeInTheDocument();
  });

  it('says when the notices or the stamps not on auto top-up could not be read, each with Retry', async () => {
    let fail = true;
    mockFetch([
      { path: '/api/funding', respond: () => jsonOk(makeView()) },
      { path: AUTO, respond: () => jsonOk(makeAutoTopUpView()) },
      {
        path: NOTICES,
        respond: () => (fail ? jsonError(500, { message: 'The database did not answer.' }) : jsonOk(EVERYONE_GETS)),
      },
      {
        path: UNMARKED,
        respond: () => (fail ? jsonError(502, { message: 'The manager did not answer.' }) : jsonOk({ stamps: [] })),
      },
    ]);
    await openTab();

    expect(await screen.findByText('The notices could not be read: The database did not answer.')).toBeInTheDocument();
    expect(
      await screen.findByText('The stamps not on auto top-up could not be read: The manager did not answer.'),
    ).toBeInTheDocument();
    fail = false;
    for (const retry of screen.getAllByRole('button', { name: 'Retry' })) fireEvent.click(retry);
    expect(await screen.findByText('No stamp off auto top-up is running low.')).toBeInTheDocument();
    expect(await section('Notices').findByText('Top-ups coming up')).toBeInTheDocument();
  });

  it('shows each job with its pause switch, its last run and its outcome, and pauses one', async () => {
    let auto = makeAutoTopUpView({
      jobs: makeAutoTopUpView().jobs.map((job) =>
        job.job === 'stamp' ? { ...job, lastOk: false, lastOutcome: 'The manager did not answer.' } : job,
      ),
    });
    const fetchMock = serve(
      () => auto,
      [
        {
          path: JOB_WALLET,
          method: 'PUT',
          respond: () => {
            auto = {
              ...auto,
              jobs: auto.jobs.map((job) =>
                job.job === 'wallet'
                  ? { ...job, paused: true, pausedBy: 'operator', pausedAt: new Date().toISOString() }
                  : job,
              ),
            };
            return jsonOk(auto);
          },
        },
      ],
    );
    await openTab();

    const jobs = section('Jobs');
    expect(await jobs.findByRole('switch', { name: 'Alert job' })).toBeChecked();
    expect(jobs.getByRole('switch', { name: 'Stamp job' })).toBeChecked();
    const ran = formatAgo('2026-10-05T09:55:00.000Z');
    expect(jobs.getByText(`Last run ${ran}: The alert job found nothing to do.`)).toBeInTheDocument();
    expect(jobs.getByText(`Last run ${ran}: The manager did not answer.`)).toBeInTheDocument();

    fireEvent.click(jobs.getByRole('switch', { name: 'Wallet job' }));
    await waitFor(() => expect(jobs.getByRole('switch', { name: 'Wallet job' })).not.toBeChecked());
    expect(jobs.getByText('Paused by operator, less than a minute ago.')).toBeInTheDocument();
    expect(bodiesOf(fetchMock, JOB_WALLET)).toEqual([{ paused: true }]);
  });

  it('says why the view could not be read, with Retry', async () => {
    let fail = true;
    mockFetch([
      { path: '/api/funding', respond: () => jsonOk(makeView()) },
      {
        path: AUTO,
        respond: () =>
          fail
            ? jsonError(500, { error: 'internal', message: 'The database did not answer.' })
            : jsonOk(makeAutoTopUpView()),
      },
      { path: NOTICES, respond: () => jsonOk(EVERYONE_GETS) },
      { path: UNMARKED, respond: () => jsonOk({ stamps: [] }) },
    ]);
    renderWithProviders(<FundingPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Auto top-up' }));

    expect(await screen.findByText('Auto top-up could not be read: The database did not answer.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Where things stand' })).toBeInTheDocument();
  });
});

describe('the numbers', () => {
  it('shows the saved numbers, with the daily ceiling empty while it follows the estimate', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();

    expect(await screen.findByRole('textbox', { name: 'Top up when under (days)' })).toHaveValue('7');
    expect(field('Top up to (days)')).toHaveValue('14');
    expect(field('Look ahead (days)')).toHaveValue('1');
    expect(field('Margin (%)')).toHaveValue('10');
    expect(field('xDAI warning (xDAI)')).toHaveValue('0.1');
    expect(field('Daily ceiling (xBZZ)')).toHaveValue('');
    expect(screen.getByText('Empty, it follows half the monthly estimate.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeDisabled();
  });

  it('shows why the numbers cannot be saved before a save', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();
    await screen.findByRole('textbox', { name: 'Top up to (days)' });

    type('Top up to (days)', '6');
    expect(screen.getByText('Top up to is more days than Top up when under.')).toBeInTheDocument();
    type('Top up to (days)', '14');
    type('Look ahead (days)', '4');
    expect(screen.getByText('Look ahead is at most half of Top up when under.')).toBeInTheDocument();
    type('xDAI warning (xDAI)', '');
    expect(screen.getByText(XDAI_WARNING_EMPTY)).toBeInTheDocument();
    type('Margin (%)', '101');
    expect(screen.getByText('Margin is a whole number from 0 to 100.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeDisabled();
  });

  it('saves the numbers behind the password, and answers a wrong password', async () => {
    let auto = makeAutoTopUpView();
    let refuse = true;
    const fetchMock = serve(
      () => auto,
      [
        {
          path: SETTINGS,
          method: 'PUT',
          respond: (init) => {
            if (refuse) {
              refuse = false;
              return jsonError(401, { error: 'invalid_credentials', message: 'Wrong password.' });
            }
            const { settings } = JSON.parse(String(init?.body)) as { settings: AutoTopUpView['settings'] };
            auto = makeAutoTopUpView({
              settings,
              settingsSavedBy: 'operator',
              settingsSavedAt: new Date().toISOString(),
            });
            return jsonOk(auto);
          },
        },
      ],
    );
    await openTab();
    await screen.findByRole('textbox', { name: 'Top up to (days)' });

    type('Top up when under (days)', '10');
    type('Top up to (days)', '21');
    type('Daily ceiling (xBZZ)', '2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Save the auto top-up numbers' }));
    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('That is not your password.')).toBeInTheDocument();

    fireEvent.change(dialog.getByLabelText('Your password'), { target: { value: 'right' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const sent = {
      topUpUnderDays: 10,
      topUpToDays: 21,
      lookAheadDays: 1,
      marginPercent: 10,
      xdaiWarningWei: '100000000000000000',
      dailyCeilingPlur: xbzz('2.5'),
    };
    expect(bodiesOf(fetchMock, SETTINGS)).toEqual([
      { password: 'wrong', settings: sent },
      { password: 'right', settings: sent },
    ]);
    expect(field('Top up to (days)')).toHaveValue('21');
    expect(field('Daily ceiling (xBZZ)')).toHaveValue('2.5');
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeDisabled();
    expect(screen.getByText('Saved by operator, less than a minute ago.')).toBeInTheDocument();
  });

  it('keeps what was typed while another tab is shown', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();
    await screen.findByRole('textbox', { name: 'Margin (%)' });

    type('Margin (%)', '15');
    fireEvent.click(screen.getByRole('tab', { name: 'Balance' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Auto top-up' }));

    expect(await screen.findByRole('textbox', { name: 'Margin (%)' })).toHaveValue('15');
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeEnabled();
  });
});
