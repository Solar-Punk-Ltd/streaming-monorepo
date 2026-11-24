import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { StreamFormPage } from '../pages/StreamFormPage';
import { jsonOk, makeStage, makeStream, mockFetch, type Route as MockRoute, renderWithProviders } from './helpers';

const OTHER_STAGE_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STAGES = [makeStage(), makeStage({ stageId: OTHER_STAGE_ID, name: 'Side stage' })];
const TEST_STAGE_REQUIRED = 'Pick the stage the test runs on.';

/** The form's controls, by the labels the stream form gives them. */
const FORM_CONTROL = { selector: 'input, textarea' };
const nameField = () => screen.getByLabelText('Stream Name *', FORM_CONTROL);
const descriptionField = () => screen.getByLabelText('Description *', FORM_CONTROL);
const tagsField = () => screen.getByLabelText('Tags', FORM_CONTROL);
const dateField = () => screen.getByLabelText('Scheduled Date *', FORM_CONTROL);
const timeField = () => screen.getByLabelText('Scheduled Time *', FORM_CONTROL);
const thumbnailPicker = () => screen.getByLabelText('Upload Thumbnail (Max 5MB)');
const stageField = () => screen.getByLabelText('Stage');
const testBox = () => screen.getByRole('checkbox', { name: 'Test stream' });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create Stream' }));

/** A file whose first bytes are a real PNG's. */
function fakeImage(): File {
  return new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], 'card.png', {
    type: 'image/png',
  });
}

function Opened() {
  const { id } = useParams();
  return <div data-testid="opened">{id}</div>;
}

function renderForm(route = '/create') {
  return renderWithProviders(
    <Routes>
      <Route path="/create" element={<StreamFormPage />} />
      <Route path="/edit/:id" element={<StreamFormPage />} />
      <Route path="/streams/:id" element={<Opened />} />
    </Routes>,
    { route },
  );
}

/** The stages, and a test stream created as `new-test`, with what each create sent. */
function serve(extra: MockRoute[] = []) {
  const sent: { path: string; body: unknown }[] = [];
  const fetchMock = mockFetch([
    ...extra,
    { path: '/api/stages', respond: () => jsonOk({ stages: STAGES }) },
    {
      method: 'POST',
      path: '/api/streams/test',
      respond: (init) => {
        sent.push({ path: '/api/streams/test', body: JSON.parse(String(init?.body)) });
        return jsonOk(makeStream({ id: 'new-test', title: 'Soundcheck', test: true, description: '' }), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/streams',
      respond: (init) => {
        sent.push({ path: '/api/streams', body: JSON.parse(String(init?.body)) });
        return jsonOk(makeStream({ id: 'new-event', title: 'Opening night' }), 201);
      },
    },
  ]);
  return { sent, fetchMock };
}

describe('Create New Stream: the Test stream box', () => {
  it('sits under Stream Name, unchecked, with what a test stream is', async () => {
    serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    expect(screen.getByRole('heading', { name: 'Create New Stream' })).toBeInTheDocument();
    expect(testBox()).not.toBeChecked();
    expect(screen.getByText('Test stream will not be visible to viewers.')).toBeInTheDocument();
    // Directly under the name: the next field in the form's order.
    const controls = [...document.querySelectorAll('input, textarea, select')];
    expect(controls.indexOf(testBox())).toBe(controls.indexOf(nameField()) + 1);
  });

  it('disables Description, Tags, the schedule with its shortcuts and the thumbnail, and keeps Name and Stage', async () => {
    serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    expect(screen.getByText('In 1 hour')).toBeInTheDocument();
    fireEvent.click(testBox());

    expect(descriptionField()).toBeDisabled();
    expect(tagsField()).toBeDisabled();
    expect(dateField()).toBeDisabled();
    expect(timeField()).toBeDisabled();
    expect(screen.queryByText('In 1 hour')).not.toBeInTheDocument();
    expect(thumbnailPicker()).toBeDisabled();
    expect(nameField()).toBeEnabled();
    expect(stageField()).toBeEnabled();
  });

  it('gives the fields back as they were when unchecked', async () => {
    serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(descriptionField(), { target: { value: 'The opening talk' } });
    const day = (dateField() as HTMLInputElement).value;

    fireEvent.click(testBox());
    fireEvent.click(testBox());

    expect(testBox()).not.toBeChecked();
    expect(descriptionField()).toBeEnabled();
    expect(descriptionField()).toHaveValue('The opening talk');
    expect(dateField()).toBeEnabled();
    expect(dateField()).toHaveValue(day);
    expect(tagsField()).toBeEnabled();
    expect(thumbnailPicker()).toBeEnabled();
  });

  it('creates a video test stream on the stage, with no description, schedule or image, and opens its page', async () => {
    const { sent, fetchMock } = serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(thumbnailPicker(), { target: { files: [fakeImage()] } });
    await screen.findByText('card.png');
    fireEvent.change(nameField(), { target: { value: '  Soundcheck  ' } });
    fireEvent.change(dateField(), { target: { value: '' } });
    fireEvent.click(testBox());
    fireEvent.change(stageField(), { target: { value: OTHER_STAGE_ID } });
    create();

    expect(await screen.findByTestId('opened')).toHaveTextContent('new-test');
    expect(sent).toEqual([
      { path: '/api/streams/test', body: { title: 'Soundcheck', mediaType: 'video', stageId: OTHER_STAGE_ID } },
    ]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/thumbnail'))).toBe(false);
  });

  it('asks for a stage before sending a test stream', async () => {
    const { sent } = serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(nameField(), { target: { value: 'Soundcheck' } });
    fireEvent.click(testBox());
    create();

    expect(await screen.findByText(TEST_STAGE_REQUIRED)).toBeInTheDocument();
    expect(sent).toEqual([]);

    fireEvent.change(stageField(), { target: { value: OTHER_STAGE_ID } });
    expect(screen.queryByText(TEST_STAGE_REQUIRED)).not.toBeInTheDocument();
  });

  it('opens checked, on the stage "Test this setup" brings', async () => {
    serve();
    renderForm(`/create?test=1&stageId=${OTHER_STAGE_ID}`);

    await screen.findByRole('option', { name: 'Side stage' });
    expect(testBox()).toBeChecked();
    await waitFor(() => expect(stageField()).toHaveValue(OTHER_STAGE_ID));
    expect(descriptionField()).toBeDisabled();
  });

  it('creates a video test stream from an address that names audio, as from an older audio stream', async () => {
    const { sent } = serve();
    renderForm(`/create?test=1&stageId=${OTHER_STAGE_ID}&mediaType=audio`);

    await screen.findByRole('option', { name: 'Side stage' });
    expect(screen.queryByText('Audio Only')).not.toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: 'Soundcheck' } });
    create();

    expect(await screen.findByTestId('opened')).toHaveTextContent('new-test');
    expect(sent).toEqual([
      { path: '/api/streams/test', body: { title: 'Soundcheck', mediaType: 'video', stageId: OTHER_STAGE_ID } },
    ]);
  });

  it('is not on Edit Stream', async () => {
    serve([{ path: '/api/streams/s1', respond: () => jsonOk(makeStream({ id: 's1', title: 'Opening night' })) }]);
    renderForm('/edit/s1');

    expect(await screen.findByRole('heading', { name: 'Edit Stream' })).toBeInTheDocument();
    await screen.findByDisplayValue('Opening night');
    expect(screen.queryByRole('checkbox', { name: 'Test stream' })).not.toBeInTheDocument();
  });

  it('leaves an unchecked create as it was: a stream with its description, sent to the streams route', async () => {
    const { sent } = serve();
    renderForm();

    await screen.findByRole('option', { name: 'Side stage' });
    fireEvent.change(nameField(), { target: { value: 'Opening night' } });
    fireEvent.change(descriptionField(), { target: { value: 'The opening talk' } });
    fireEvent.change(stageField(), { target: { value: OTHER_STAGE_ID } });
    create();

    expect(await screen.findByTestId('opened')).toHaveTextContent('new-event');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      path: '/api/streams',
      body: { title: 'Opening night', description: 'The opening talk', mediaType: 'video', stageId: OTHER_STAGE_ID },
    });
  });
});
