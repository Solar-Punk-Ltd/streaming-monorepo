import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AUTO_TOPUP_DEFAULTS,
  autoTopUpStampPlan,
  autoTopUpWithMargin,
  type AutoTopUpView,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { NOT_TOPPED_UP_YET, xbzzText } from '../components/funding/autoTopUp';
import { formatDateTime } from '../dateUtil';
import { FundingPage } from '../pages/FundingPage';
import {
  BATCH,
  DAY,
  makeArchiveStamps,
  makeAutoTopUpView,
  makeBatch,
  makeMark,
  makeStampView,
  POSTAGE,
  xbzz,
} from './fundingFixtures';
import { jsonError, jsonOk, mockFetch, renderWithProviders } from './helpers';

const FUNDING = '/api/funding';
const AUTO = '/api/funding/auto-top-up';
const MARKS = '/api/funding/auto-top-up/marks';

/** The Funding view, the Auto top-up view, and the answer to a mark, each from a getter a test can change. */
function serve(
  view: () => FundingView,
  auto: () => AutoTopUpView | Response,
  mark: (body: unknown) => Response = () => jsonOk(auto()),
) {
  return mockFetch([
    { path: FUNDING, respond: () => jsonOk(view()) },
    {
      path: AUTO,
      respond: () => {
        const answer = auto();
        return 'status' in answer && 'json' in answer ? answer : jsonOk(answer);
      },
    },
    { path: MARKS, method: 'PUT', respond: (init) => mark(JSON.parse(String(init?.body))) },
    { path: '/api/archive/stamps', respond: () => jsonOk(makeArchiveStamps()) },
  ]);
}

async function openStamps() {
  renderWithProviders(<FundingPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Stamps' }));
  await screen.findByRole('heading', { name: 'Catalogue batch' });
}

const table = (name: string) => within(screen.getByRole('table', { name }));
const rowOf = (name: string, text: string) => within(table(name).getByText(text).closest('tr') as HTMLElement);
const switchOf = (label: string) => screen.getByRole('switch', { name: `Auto top-up for the batch of ${label}` });

/** The bodies the page sent to the marks route, in order. */
const markBodies = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === MARKS && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

/** The Stamps view with the second stage's rung at `ttlDays` left and holding `xbzzPlur`. */
function withRung(ttlDays: number, xbzzPlur = xbzz('5')): FundingView {
  const view = makeStampView();
  const [rung] = view.stages[1]?.nodes ?? [];
  if (view.stages[1] && rung) {
    view.stages[1].nodes = [
      { ...rung, xbzzPlur, batch: makeBatch({ batchId: BATCH.rung, ttlSeconds: ttlDays * DAY, fillRatio: 0.7 }) },
    ];
  }
  return view;
}

const RUNG_MARK = makeMark({ batchId: BATCH.rung, nodeId: 'stage-2:360p', nodeLabel: 'pool-360p' });

describe('the Auto top-up switch on the Stamps tab', () => {
  it('is on every row the tab tops up, off while unmarked, and on no row that cannot be topped up', async () => {
    serve(makeStampView, () => makeAutoTopUpView());
    await openStamps();

    await waitFor(() => expect(switchOf('catalogue-node')).not.toBeChecked());
    expect(switchOf('stage-1-uploader')).not.toBeChecked();
    expect(switchOf('pool-360p')).not.toBeChecked();
    expect(rowOf('Batches of Main stage', 'rung-720p').queryByRole('switch')).not.toBeInTheDocument();
    expect(rowOf('Batches of Main stage', 'rung-1080p').queryByRole('switch')).not.toBeInTheDocument();
  });

  it('marks one stamp with its node and batch, and shows it marked from the answer', async () => {
    let auto = makeAutoTopUpView();
    const fetchMock = serve(
      makeStampView,
      () => auto,
      () => {
        auto = makeAutoTopUpView({ stamps: [RUNG_MARK] });
        return jsonOk(auto);
      },
    );
    await openStamps();

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto top-up for the batch of pool-360p' }));

    await waitFor(() => expect(switchOf('pool-360p')).toBeChecked());
    expect(markBodies(fetchMock)).toEqual([{ marked: true, items: [{ nodeId: 'stage-2:360p', batchId: BATCH.rung }] }]);
    expect(rowOf('Batches of Second stage', 'pool-360p').getByText(NOT_TOPPED_UP_YET)).toBeInTheDocument();
  });

  it("shows a marked row's last automatic top-up, its next one, and what stopped the last attempt", async () => {
    const dueAt = '2026-10-30T09:00:00.000Z';
    const mark = makeMark({
      lastTopUp: { at: '2026-10-02T09:00:00.000Z', days: 7, costPlur: xbzz('0.3') },
      coming: {
        due: false,
        dueAt,
        days: 7,
        costPlur: xbzz('0.304'),
        costWithMarginPlur: xbzz('0.335'),
        sendPlur: '0',
        gasSend: false,
        alertedAt: null,
        sendAt: null,
      },
      problem: "The node's view of the chain was behind for an hour.",
    });
    serve(makeStampView, () => makeAutoTopUpView({ stamps: [mark] }));
    await openStamps();

    await waitFor(() => expect(switchOf('catalogue-node')).toBeChecked());
    const row = rowOf('Catalogue batch', 'catalogue-node');
    expect(
      row.getByText(`Last topped up automatically ${formatDateTime('2026-10-02T09:00:00.000Z')}, by 7 days.`),
    ).toBeInTheDocument();
    expect(
      row.getByText(`Next top-up due about ${formatDateTime(dueAt)}: 7 days for about 0.304 xBZZ.`),
    ).toBeInTheDocument();
    expect(row.getByText("The node's view of the chain was behind for an hour.")).toBeInTheDocument();
  });

  it("works out a marked row's next top-up at today's price while the alert job has none for it", async () => {
    serve(makeStampView, () => makeAutoTopUpView({ stamps: [makeMark()] }));
    await openStamps();

    const plan = autoTopUpStampPlan({ depth: 20, ttlSeconds: 40 * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
    const row = rowOf('Catalogue batch', 'catalogue-node');
    expect(
      await row.findByText(
        (text) =>
          text.startsWith('Next top-up due about ') && text.endsWith(`: 7 days for about ${xbzzText(plan.costPlur)}.`),
      ),
    ).toBeInTheDocument();
  });

  it('keeps the switch on a marked row that cannot be topped up any more, so the mark can come off', async () => {
    const expired = makeMark({
      batchId: BATCH.expired,
      nodeId: 'stage-1:720p',
      nodeLabel: 'rung-720p',
      problem: 'It expired, so it takes a Buy new.',
    });
    let auto = makeAutoTopUpView({ stamps: [expired] });
    const fetchMock = serve(
      makeStampView,
      () => auto,
      () => {
        auto = makeAutoTopUpView();
        return jsonOk(auto);
      },
    );
    await openStamps();

    await waitFor(() => expect(switchOf('rung-720p')).toBeChecked());
    expect(
      rowOf('Batches of Main stage', 'rung-720p').getByText('It expired, so it takes a Buy new.'),
    ).toBeInTheDocument();
    fireEvent.click(switchOf('rung-720p'));

    await waitFor(() =>
      expect(rowOf('Batches of Main stage', 'rung-720p').queryByRole('switch')).not.toBeInTheDocument(),
    );
    expect(markBodies(fetchMock)).toEqual([
      { marked: false, items: [{ nodeId: 'stage-1:720p', batchId: BATCH.expired }] },
    ]);
  });

  it('marks and unmarks the ticked batches together, as Select all and the group tick boxes tick them', async () => {
    let auto = makeAutoTopUpView({ stamps: [makeMark()] });
    const fetchMock = serve(
      makeStampView,
      () => auto,
      (body) => {
        const { marked } = body as { marked: boolean };
        auto = makeAutoTopUpView({
          stamps: marked
            ? [
                makeMark(),
                makeMark({ batchId: BATCH.stage, nodeId: 'stage-1:bee', nodeLabel: 'stage-1-uploader' }),
                RUNG_MARK,
              ]
            : [makeMark(), makeMark({ batchId: BATCH.stage, nodeId: 'stage-1:bee', nodeLabel: 'stage-1-uploader' })],
        });
        return jsonOk(auto);
      },
    );
    await openStamps();
    await waitFor(() => expect(switchOf('catalogue-node')).toBeChecked());

    expect(screen.getByRole('button', { name: 'Auto top-up on for 0 batches' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto top-up on for 2 batches' }));
    await waitFor(() => expect(switchOf('pool-360p')).toBeChecked());
    expect(switchOf('stage-1-uploader')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Top up every batch of Second stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto top-up off for 1 batch' }));
    await waitFor(() => expect(switchOf('pool-360p')).not.toBeChecked());

    expect(markBodies(fetchMock)).toEqual([
      {
        marked: true,
        items: [
          { nodeId: 'stage-1:bee', batchId: BATCH.stage },
          { nodeId: 'stage-2:360p', batchId: BATCH.rung },
        ],
      },
      { marked: false, items: [{ nodeId: 'stage-2:360p', batchId: BATCH.rung }] },
    ]);
  });

  it('shows the 409 not_markable answer and leaves the stamp unmarked', async () => {
    serve(makeStampView, makeAutoTopUpView, () =>
      jsonError(409, { error: 'not_markable', message: 'The batch of pool-360p cannot be topped up by the admin.' }),
    );
    await openStamps();

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto top-up for the batch of pool-360p' }));

    expect(await screen.findByText('The batch of pool-360p cannot be topped up by the admin.')).toBeInTheDocument();
    expect(switchOf('pool-360p')).not.toBeChecked();
    expect(rowOf('Batches of Second stage', 'pool-360p').queryByText(NOT_TOPPED_UP_YET)).not.toBeInTheDocument();
  });

  it('says why the switches are missing when the auto top-up view cannot be read', async () => {
    serve(makeStampView, () => jsonError(500, { error: 'internal', message: 'The database did not answer.' }));
    await openStamps();

    expect(await screen.findByText('Auto top-up could not be read: The database did not answer.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('marking a stamp that is already due', () => {
  /** The rung's plan at `ttlDays` left: due, with the days, the cost and the cost with the margin. */
  const rungPlan = (ttlDays: number) =>
    autoTopUpStampPlan({ depth: 20, ttlSeconds: ttlDays * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
  const head = (ttlDays: number) => {
    const plan = rungPlan(ttlDays);
    return `The batch 0xcccccc…cccccc of pool-360p is due now: its top-up of ${plan.days} days costs about ${xbzzText(plan.costPlur)}.`;
  };

  async function markRung(view: FundingView) {
    serve(
      () => view,
      () => makeAutoTopUpView(),
      () => jsonOk(makeAutoTopUpView({ stamps: [RUNG_MARK] })),
    );
    await openStamps();
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto top-up for the batch of pool-360p' }));
  }

  it('says its node holds the cost, so the next run tops it up', async () => {
    await markRung(withRung(5));

    expect(
      await screen.findByText(
        `${head(5)} pool-360p holds that, so it is topped up at the next run, within 10 minutes.`,
      ),
    ).toBeInTheDocument();
  });

  it('says what the brand wallet sends a short node, a day after the alert the next run gives', async () => {
    await markRung(withRung(5, xbzz('0.1')));

    const lack = (BigInt(autoTopUpWithMargin(rungPlan(5).costPlur, 10)) - BigInt(xbzz('0.1'))).toString();
    expect(
      await screen.findByText(
        `${head(5)} pool-360p holds 0.100 xBZZ, so the brand wallet sends it ${xbzzText(lack)} with the margin, 1 day after the alert, which goes out at the next run.`,
      ),
    ).toBeInTheDocument();
  });

  it('says the brand wallet sends at once with under two look-aheads left', async () => {
    await markRung(withRung(1, xbzz('0.1')));

    const lack = (BigInt(autoTopUpWithMargin(rungPlan(1).costPlur, 10)) - BigInt(xbzz('0.1'))).toString();
    expect(
      await screen.findByText(
        `${head(1)} pool-360p holds 0.100 xBZZ, so the brand wallet sends it ${xbzzText(lack)} with the margin, at the next run, within 10 minutes: with under 2 days left, it does not wait 1 day after the alert.`,
      ),
    ).toBeInTheDocument();
  });

  it('says nothing more for a stamp that is not due', async () => {
    await markRung(withRung(20));

    await waitFor(() => expect(switchOf('pool-360p')).toBeChecked());
    expect(screen.queryByText(/is due now/)).not.toBeInTheDocument();
  });
});
