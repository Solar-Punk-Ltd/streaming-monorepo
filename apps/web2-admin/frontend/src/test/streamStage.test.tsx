import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { StageSummary, Stream } from '@streaming-monorepo/web2-admin-common';

import { NO_STAGE_FOR_RECORDING } from '../components/stages/StageField';
import { STAGE_LOCKED } from '../errors';
import { FIRST_STAGE_IS_FINAL, StreamFormPage } from '../pages/StreamFormPage';
import { StreamsPage } from '../pages/StreamsPage';
import { MAIN_STAGE_ID, jsonOk, makeStage, makeStream, mockFetch, renderWithProviders } from './helpers';

const SECOND_STAGE_ID = '8c3f5d1b-4e5f-4061-9c73-3d4e5f607182';
const RETIRED_STAGE_ID = '6a1d3b9f-2c3d-4e4f-9a51-1b2c3d4e5f60';
const OME_STAGE_ID = '7b2e4c0a-3d4e-4f50-8b62-2c3d4e5f6071';

const RETIRED = makeStage({ stageId: RETIRED_STAGE_ID, name: 'Old stage', retiredAt: '2026-09-28T11:00:00.000Z' });
const OME = makeStage({ stageId: OME_STAGE_ID, name: 'OME stage', engine: 'ome', supported: false });

/** The address `makeStage()` signs as, the way a stream row keeps an owner. */
const MAIN_STAGE_OWNER = '3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
/** A stage with a key of its own, which a recording signed as the main stage's owner cannot take. */
const OTHER_KEY = makeStage({
  stageId: SECOND_STAGE_ID,
  name: 'Other key',
  owner: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
});

const stageSelect = () => screen.getByLabelText('Stage') as HTMLSelectElement;
const optionLabels = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

function renderCreate(stages: StageSummary[], onCreate: (body: Record<string, unknown>) => void = () => undefined) {
  mockFetch([
    { path: '/api/stages', respond: () => jsonOk({ stages }) },
    {
      method: 'POST',
      path: '/api/streams',
      respond: (init) => {
        onCreate(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonOk(makeStream({ id: 'new-id' }), 201);
      },
    },
  ]);
  return renderWithProviders(
    <Routes>
      <Route path="/create" element={<StreamFormPage />} />
      <Route path="/streams/:id" element={<div>details page</div>} />
    </Routes>,
    { route: '/create' },
  );
}

function renderEdit(
  stream: Stream,
  stages: StageSummary[],
  onUpdate: (body: Record<string, unknown>) => void = () => undefined,
) {
  mockFetch([
    { path: '/api/stages', respond: () => jsonOk({ stages }) },
    { path: `/api/streams/${stream.id}`, respond: () => jsonOk(stream) },
    {
      method: 'PUT',
      path: `/api/streams/${stream.id}`,
      respond: (init) => {
        onUpdate(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonOk(stream);
      },
    },
  ]);
  return renderWithProviders(
    <Routes>
      <Route path="/edit/:id" element={<StreamFormPage />} />
      <Route path="/streams/:id" element={<div>details page</div>} />
    </Routes>,
    { route: `/edit/${stream.id}` },
  );
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Stream Name *', { selector: 'input' }), {
    target: { value: 'Opening keynote' },
  });
  fireEvent.change(screen.getByLabelText('Description *', { selector: 'textarea' }), {
    target: { value: 'The opening talk' },
  });
}

describe('the stream form stage picker', () => {
  it('preselects the one stage a new stream could go on, and sends it', async () => {
    const sent: Record<string, unknown>[] = [];
    renderCreate([makeStage(), RETIRED, OME], (body) => sent.push(body));

    await waitFor(() => expect(stageSelect().value).toBe(MAIN_STAGE_ID));
    // A retired stage and an OvenMediaEngine one take no new streams.
    expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage']);

    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create Stream' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBe(MAIN_STAGE_ID);
  });

  it('leaves the choice to the operator when two stages could take the stream', async () => {
    const sent: Record<string, unknown>[] = [];
    renderCreate([makeStage(), makeStage({ stageId: SECOND_STAGE_ID, name: 'Second stage' })], (body) =>
      sent.push(body),
    );

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage', 'Second stage']));
    expect(stageSelect().value).toBe('');

    fireEvent.change(stageSelect(), { target: { value: SECOND_STAGE_ID } });
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create Stream' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBe(SECOND_STAGE_ID);
  });

  it('says so when no stage takes streams yet, and creates the stream with none', async () => {
    const sent: Record<string, unknown>[] = [];
    renderCreate([RETIRED], (body) => sent.push(body));

    expect(await screen.findByText(/No stage takes streams yet/)).toBeInTheDocument();
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create Stream' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBeNull();
  });

  it('warns, without blocking, when the chosen stage is not ready, and says when it was last confirmed', async () => {
    renderCreate([makeStage({ readiness: { tone: 'warning', reasons: ['720p batch has 30 hours left'] } })]);

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('Main stage has a warning: 720p batch has 30 hours left.');
    expect(warning).toHaveTextContent('The manager last confirmed it 5 minutes ago.');
    expect(screen.getByRole('button', { name: 'Create Stream' })).toBeEnabled();
  });

  it.each([
    ['warning', 'Main stage has a warning: 720p batch has 30 hours left; uploader is slow.'],
    ['blocked', 'Main stage is blocked: 720p batch has 30 hours left; uploader is slow.'],
    ['unknown', "Main stage's readiness is unknown: 720p batch has 30 hours left; uploader is slow."],
  ] as const)('words a stage whose readiness is %s in a sentence of its own', async (tone, sentence) => {
    renderCreate([makeStage({ readiness: { tone, reasons: ['720p batch has 30 hours left', 'uploader is slow'] } })]);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `${sentence} The manager last confirmed it 5 minutes ago.`,
    );
  });

  it('leaves the reasons out of the sentence when the manager gave none', async () => {
    renderCreate([makeStage({ readiness: { tone: 'blocked', reasons: [] } })]);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Main stage is blocked. The manager last confirmed it 5 minutes ago.',
    );
  });

  it('says nothing about the readiness of the stage of a published stream, which cannot change', async () => {
    renderEdit(makeStream({ id: 'pub-id', status: 'published', stageId: MAIN_STAGE_ID }), [
      makeStage({ readiness: { tone: 'warning', reasons: ['Uploader not answering'] } }),
    ]);

    await waitFor(() => expect(stageSelect().value).toBe(MAIN_STAGE_ID));
    expect(stageSelect()).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing about a retired stage that a stream which holds its recording keeps', async () => {
    renderEdit(
      makeStream({ id: 'vod-id', status: 'vod', stageId: RETIRED_STAGE_ID, manifestIndex: 7, durationSeconds: 61 }),
      [makeStage(), { ...RETIRED, readiness: { tone: 'blocked', reasons: ['Deployment gone'] } }],
    );

    await waitFor(() => expect(stageSelect().value).toBe(RETIRED_STAGE_ID));
    expect(stageSelect()).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing about a stage that is ready', async () => {
    renderCreate([makeStage()]);

    await waitFor(() => expect(stageSelect().value).toBe(MAIN_STAGE_ID));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('moves a draft to another stage', async () => {
    const sent: Record<string, unknown>[] = [];
    const draft = makeStream({ id: 'draft-id', stageId: MAIN_STAGE_ID });
    renderEdit(draft, [makeStage(), makeStage({ stageId: SECOND_STAGE_ID, name: 'Second stage' })], (body) =>
      sent.push(body),
    );

    await waitFor(() => expect(stageSelect().value).toBe(MAIN_STAGE_ID));
    expect(stageSelect()).toBeEnabled();
    fireEvent.change(stageSelect(), { target: { value: SECOND_STAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Stream' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBe(SECOND_STAGE_ID);
  });

  it('does not preselect a stage for a draft that has none', async () => {
    renderEdit(makeStream({ id: 'bare-id', stageId: null }), [makeStage()]);

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage']));
    expect(stageSelect().value).toBe('');
  });

  it('locks the stage once the stream is published, and still sends the one it has', async () => {
    const sent: Record<string, unknown>[] = [];
    renderEdit(makeStream({ id: 'pub-id', status: 'published', stageId: MAIN_STAGE_ID }), [makeStage()], (body) =>
      sent.push(body),
    );

    await waitFor(() => expect(stageSelect()).toBeDisabled());
    expect(screen.getByText(STAGE_LOCKED.published)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update Stream' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBe(MAIN_STAGE_ID);
  });

  it('locks the stage of a draft that holds a recording', async () => {
    renderEdit(
      makeStream({ id: 'rec-id', status: 'draft', stageId: MAIN_STAGE_ID, manifestIndex: 7, durationSeconds: 61 }),
      [makeStage()],
    );

    await waitFor(() => expect(stageSelect()).toBeDisabled());
    expect(screen.getByText(STAGE_LOCKED.recording)).toBeInTheDocument();
  });

  it('locks the stage of a draft whose recording is named by reference', async () => {
    renderEdit(
      makeStream({
        id: 'ref-id',
        status: 'draft',
        stageId: MAIN_STAGE_ID,
        manifestIndex: null,
        recording: 'ab'.repeat(32),
        durationSeconds: 61,
      }),
      [makeStage()],
    );

    await waitFor(() => expect(stageSelect()).toBeDisabled());
    expect(screen.getByText(STAGE_LOCKED.recording)).toBeInTheDocument();
  });

  it('warns that the first stage of a recording from before stages is final, and asks before saving it', async () => {
    const sent: Record<string, unknown>[] = [];
    const recorded = makeStream({
      id: 'old-rec',
      owner: MAIN_STAGE_OWNER,
      status: 'draft',
      stageId: null,
      manifestIndex: 7,
      durationSeconds: 61,
    });
    renderEdit(recorded, [makeStage()], (body) => sent.push(body));

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage']));
    expect(stageSelect()).toBeEnabled();
    expect(screen.getByText(FIRST_STAGE_IS_FINAL)).toBeInTheDocument();

    fireEvent.change(stageSelect(), { target: { value: MAIN_STAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Stream' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Save with Main stage?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Update Stream' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBe(MAIN_STAGE_ID);
  });

  it('saves a recording from before stages without asking while it stays without a stage', async () => {
    const sent: Record<string, unknown>[] = [];
    const recorded = makeStream({
      id: 'old-rec',
      owner: MAIN_STAGE_OWNER,
      status: 'draft',
      stageId: null,
      manifestIndex: 7,
      durationSeconds: 61,
    });
    renderEdit(recorded, [makeStage()], (body) => sent.push(body));

    await waitFor(() => expect(stageSelect()).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Update Stream' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.stageId).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a recording from before stages only the stages that sign as its owner', async () => {
    const recorded = makeStream({
      id: 'old-rec',
      owner: MAIN_STAGE_OWNER.toUpperCase(),
      status: 'draft',
      stageId: null,
      manifestIndex: 7,
      durationSeconds: 61,
    });
    renderEdit(recorded, [makeStage(), OTHER_KEY]);

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage']));
  });

  it('says so when no stage signs as the owner of a recording from before stages', async () => {
    const recorded = makeStream({
      id: 'old-rec',
      status: 'draft',
      stageId: null,
      manifestIndex: 7,
      durationSeconds: 61,
    });
    renderEdit(recorded, [makeStage(), OTHER_KEY]);

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage']));
    expect(screen.getByText(NO_STAGE_FOR_RECORDING)).toBeInTheDocument();
  });

  it('offers every stage to a draft that holds no recording, whatever it signs as', async () => {
    renderEdit(makeStream({ id: 'bare-id', stageId: null }), [makeStage(), OTHER_KEY]);

    await waitFor(() => expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage', 'Other key']));
  });

  it('says nothing about a final first stage on a draft that holds no recording', async () => {
    renderEdit(makeStream({ id: 'bare-id', stageId: null }), [makeStage()]);

    await waitFor(() => expect(stageSelect()).toBeEnabled());
    expect(screen.queryByText(FIRST_STAGE_IS_FINAL)).not.toBeInTheDocument();
  });

  it('shows the stream on a stage the manager retired, and says it takes no new streams', async () => {
    renderEdit(makeStream({ id: 'old-id', stageId: RETIRED_STAGE_ID }), [makeStage(), RETIRED]);

    await waitFor(() => expect(stageSelect().value).toBe(RETIRED_STAGE_ID));
    expect(optionLabels(stageSelect())).toEqual(['No stage', 'Main stage', 'Old stage (retired)']);
    expect(await screen.findByText(/The manager retired this stage/)).toBeInTheDocument();
  });
});

describe('My Streams by stage', () => {
  const streams = [
    makeStream({ title: 'On main', stageId: MAIN_STAGE_ID }),
    makeStream({ title: 'On old', stageId: RETIRED_STAGE_ID }),
    makeStream({ title: 'Nowhere', stageId: null }),
  ];

  function renderList() {
    mockFetch([
      { path: '/api/streams', respond: () => jsonOk({ streams }) },
      { path: '/api/stages', respond: () => jsonOk({ stages: [makeStage(), RETIRED] }) },
    ]);
    renderWithProviders(<StreamsPage />);
  }

  const rowOf = (title: string) => screen.getByText(title).closest('tr') as HTMLElement;

  it('names the stage of each stream in a column of its own', async () => {
    renderList();

    await screen.findByText('On main');
    expect(screen.getByRole('columnheader', { name: 'Stage' })).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf('On main')).getByText('Main stage')).toBeInTheDocument());
    expect(within(rowOf('On old')).getByText('Old stage (retired)')).toBeInTheDocument();
    expect(within(rowOf('Nowhere')).getByText('No stage')).toBeInTheDocument();
  });

  it('filters the list by stage, and by no stage', async () => {
    renderList();
    await screen.findByText('On main');
    const filter = screen.getByLabelText('Stage') as HTMLSelectElement;
    await waitFor(() =>
      expect(optionLabels(filter)).toEqual(['All stages', 'Main stage', 'Old stage (retired)', 'No stage']),
    );

    fireEvent.change(filter, { target: { value: MAIN_STAGE_ID } });
    expect(screen.getByText('On main')).toBeInTheDocument();
    expect(screen.queryByText('On old')).not.toBeInTheDocument();
    expect(screen.queryByText('Nowhere')).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'none' } });
    expect(screen.getByText('Nowhere')).toBeInTheDocument();
    expect(screen.queryByText('On main')).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'all' } });
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('says so when no stream is without a stage', async () => {
    mockFetch([
      { path: '/api/streams', respond: () => jsonOk({ streams: [streams[0]] }) },
      { path: '/api/stages', respond: () => jsonOk({ stages: [makeStage()] }) },
    ]);
    renderWithProviders(<StreamsPage />);
    await screen.findByText('On main');

    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'none' } });

    expect(screen.getByText('No streams without a stage.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the list when the stages cannot be read, naming each stage by its id', async () => {
    mockFetch([{ path: '/api/streams', respond: () => jsonOk({ streams }) }]);
    renderWithProviders(<StreamsPage />);

    await screen.findByText('On main');
    expect(within(rowOf('On main')).getByText(/Unknown stage 5f0c2a8e/)).toBeInTheDocument();
  });
});
