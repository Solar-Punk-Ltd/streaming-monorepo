import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AutoTopUpView } from '@streaming-monorepo/web2-admin-common';

import { EMAIL_TWICE, XDAI_WARNING_EMPTY } from '../components/funding/autoTopUp';
import { formatAgo, formatDateTime } from '../dateUtil';
import { FundingPage } from '../pages/FundingPage';
import { BATCH, makeAutoTopUpView, makeMark, makeView, xbzz } from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders, type Route } from './helpers';

const AUTO = '/api/funding/auto-top-up';
const SETTINGS = '/api/funding/auto-top-up/settings';
const EMAILS = '/api/funding/auto-top-up/emails';
const JOB_WALLET = '/api/funding/auto-top-up/jobs/wallet';

/** The Funding view and the Auto top-up view, from a getter a test can change, and the writes a test answers. */
function serve(auto: () => AutoTopUpView, writes: Route[] = []) {
  return mockFetch([
    { path: '/api/funding', respond: () => jsonOk(makeView()) },
    { path: AUTO, respond: () => jsonOk(auto()) },
    ...writes,
  ]);
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
            mailedAt: null,
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
      screen.getByText(`Since ${formatDateTime('2026-10-05T07:00:00.000Z')}, not mailed yet.`),
    ).toBeInTheDocument();
  });

  it('says when nothing is coming up and no warning stands', async () => {
    serve(() => makeAutoTopUpView());
    await openTab();
    expect(await screen.findByText('No top-ups coming up.')).toBeInTheDocument();
    expect(screen.getByText('No warnings.')).toBeInTheDocument();
  });

  it('says whether mail is set, when the last went out and why one failed', async () => {
    let auto = makeAutoTopUpView();
    serve(() => auto);
    await openTab();
    expect(
      await screen.findByText(`Mail is set. The last mail went out ${formatAgo('2026-10-04T08:00:00.000Z')}.`),
    ).toBeInTheDocument();

    auto = makeAutoTopUpView({
      mail: { configured: false, lastSentAt: null, lastError: 'The SMTP server refused the login.' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Balance' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Auto top-up' }));
    expect(
      await screen.findByText('Mail is not set, so the alerts and warnings show on this page alone.'),
    ).toBeInTheDocument();
    expect(screen.getByText('The last mail could not be sent: The SMTP server refused the login.')).toBeInTheDocument();
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

describe('the email list', () => {
  it('adds and removes addresses, says why a line cannot be saved, and saves the list', async () => {
    let auto = makeAutoTopUpView();
    const fetchMock = serve(
      () => auto,
      [
        {
          path: EMAILS,
          method: 'PUT',
          respond: (init) => {
            const { emails } = JSON.parse(String(init?.body)) as { emails: string[] };
            auto = makeAutoTopUpView({ emails });
            return jsonOk(auto);
          },
        },
      ],
    );
    await openTab();

    expect(await screen.findByRole('textbox', { name: 'Email address 1' })).toHaveValue('ops@example.org');
    expect(screen.getByRole('button', { name: 'Save list' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add address' }));
    type('Email address 2', 'not an address');
    expect(screen.getByText('Enter an email address such as name@example.org.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save list' })).toBeDisabled();

    type('Email address 2', ' OPS@example.org ');
    expect(screen.getByText(EMAIL_TWICE)).toBeInTheDocument();

    type('Email address 2', 'Finance@Example.org');
    fireEvent.click(screen.getByRole('button', { name: 'Remove email address 1' }));
    expect(field('Email address 1')).toHaveValue('Finance@Example.org');
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));

    await waitFor(() => expect(field('Email address 1')).toHaveValue('finance@example.org'));
    expect(bodiesOf(fetchMock, EMAILS)).toEqual([{ emails: ['finance@example.org'] }]);
    expect(screen.getByRole('button', { name: 'Save list' })).toBeDisabled();
  });
});
