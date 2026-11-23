import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { StreamFormPage } from '../pages/StreamFormPage';
import { MAIN_STAGE_ID, jsonError, jsonOk, makeStage, makeStream, mockFetch, renderWithProviders } from './helpers';

const OTHER_STAGE_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function Opened() {
  const { id } = useParams();
  return <div data-testid="opened">{id}</div>;
}

function renderForm(route = '/create?test=1') {
  return renderWithProviders(
    <Routes>
      <Route path="/create" element={<StreamFormPage />} />
      <Route path="/streams/:id" element={<Opened />} />
    </Routes>,
    { route },
  );
}

const STAGES = [makeStage(), makeStage({ stageId: OTHER_STAGE_ID, name: 'Side stage' })];

const nameField = () => screen.getByLabelText('Stream Name *', { selector: 'input' });

describe('New test stream', () => {
  it('asks for a title and a stage, and nothing else: no media type, as the stream form offers none', async () => {
    mockFetch([{ path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) }]);
    renderForm();

    expect(await screen.findByRole('heading', { name: 'New test stream' })).toBeInTheDocument();
    expect(nameField()).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Side stage' })).toBeInTheDocument();
    expect(screen.getByLabelText('Stage')).toBeInTheDocument();

    expect(screen.queryByLabelText('Media type')).not.toBeInTheDocument();
    expect(screen.queryByText('Audio Only')).not.toBeInTheDocument();
    expect(screen.queryByText(/Description/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tags/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thumbnail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Scheduled/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/address/i)).not.toBeInTheDocument();
  });

  it('creates the test stream and opens its page', async () => {
    let sent: unknown = null;
    mockFetch([
      { path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) },
      {
        method: 'POST',
        path: '/api/streams/test',
        respond: (init) => {
          sent = JSON.parse(String(init?.body));
          return jsonOk(makeStream({ id: 'new-test', title: 'Soundcheck', test: true, description: '' }), 201);
        },
      },
    ]);
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(nameField(), { target: { value: '  Soundcheck  ' } });
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: OTHER_STAGE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Create test stream' }));

    expect(await screen.findByTestId('opened')).toHaveTextContent('new-test');
    expect(sent).toEqual({ title: 'Soundcheck', mediaType: 'video', stageId: OTHER_STAGE_ID });
  });

  it('creates a video test stream from an address that names audio, as from an older audio stream', async () => {
    let sent: unknown = null;
    mockFetch([
      { path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) },
      {
        method: 'POST',
        path: '/api/streams/test',
        respond: (init) => {
          sent = JSON.parse(String(init?.body));
          return jsonOk(makeStream({ id: 'new-test', title: 'Soundcheck', test: true, description: '' }), 201);
        },
      },
    ]);
    renderForm(`/create?test=1&stageId=${OTHER_STAGE_ID}&mediaType=audio`);

    await screen.findByRole('option', { name: 'Side stage' });
    expect(screen.queryByText('Audio Only')).not.toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: 'Soundcheck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create test stream' }));

    expect(await screen.findByTestId('opened')).toHaveTextContent('new-test');
    expect(sent).toEqual({ title: 'Soundcheck', mediaType: 'video', stageId: OTHER_STAGE_ID });
  });

  it('asks for a title and a stage before sending anything', async () => {
    const fetchMock = mockFetch([{ path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) }]);
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.click(screen.getByRole('button', { name: 'Create test stream' }));
    expect(await screen.findByText('Stream name is required')).toBeInTheDocument();

    fireEvent.change(nameField(), { target: { value: 'Soundcheck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create test stream' }));
    expect(await screen.findByText('Pick the stage the test runs on.')).toBeInTheDocument();

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('shows the sentence the API refuses a test stream with, and stays on the form', async () => {
    mockFetch([
      { path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) },
      {
        method: 'POST',
        path: '/api/streams/test',
        respond: () => jsonError(409, { error: 'stage_unavailable', message: 'That stage takes no streams.' }),
      },
    ]);
    renderForm(`/create?test=1&stageId=${MAIN_STAGE_ID}`);

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(nameField(), { target: { value: 'Soundcheck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create test stream' }));

    expect(await screen.findByText('That stage takes no streams.')).toBeInTheDocument();
    expect(screen.queryByTestId('opened')).not.toBeInTheDocument();
  });

  it('starts with the stage "Test this setup" brings', async () => {
    mockFetch([{ path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) }]);
    renderForm(`/create?test=1&stageId=${OTHER_STAGE_ID}`);

    await screen.findByRole('option', { name: 'Side stage' });
    await waitFor(() => expect(screen.getByLabelText('Stage')).toHaveValue(OTHER_STAGE_ID));
  });

  it('leaves /create without the mark as the form for a stream', async () => {
    mockFetch([{ path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) }]);
    renderForm('/create');

    expect(await screen.findByRole('heading', { name: 'Create New Stream' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New test stream' })).not.toBeInTheDocument();
  });
});
