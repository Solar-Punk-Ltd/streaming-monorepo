import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { STREAM_LIMITS } from '@streaming-monorepo/web2-admin-common';

import {
  MEDIA_TYPE_LOCKED,
  SCHEDULE_LOCKED,
  UNSUPPORTED_IMAGE_TYPE,
} from '../errors';
import { ERROR_MESSAGES, StreamFormPage } from '../pages/StreamFormPage';
import {
  jsonError,
  jsonOk,
  makeStream,
  mockFetch,
  renderWithProviders,
} from './helpers';

function renderCreateForm() {
  return renderWithProviders(
    <Routes>
      <Route path="/create" element={<StreamFormPage />} />
      <Route path="/streams/:id" element={<div>details page</div>} />
    </Routes>,
    { route: '/create' },
  );
}

function renderEditForm(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/edit/:id" element={<StreamFormPage />} />
    </Routes>,
    { route: `/edit/${id}` },
  );
}

const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Create Stream' }));

const typeIn = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** A File whose reported size is `size`, without allocating that many bytes. */
function fakeImage(name: string, size: number, type = 'image/png'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('StreamFormPage validation', () => {
  it('requires a stream name', () => {
    mockFetch([]);
    renderCreateForm();

    submit();

    expect(screen.getByText(ERROR_MESSAGES.NAME_REQUIRED)).toBeInTheDocument();
  });

  it('requires a description once the name is filled', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', 'Pilot keynote');
    submit();

    expect(
      screen.getByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).toBeInTheDocument();
  });

  it('requires a scheduled start time', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', 'Pilot keynote');
    typeIn('Description *', 'The opening talk');
    submit();

    expect(
      screen.getByText(ERROR_MESSAGES.SCHEDULED_TIME_REQUIRED),
    ).toBeInTheDocument();
  });

  it('rejects whitespace-only values', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', '   ');
    submit();

    expect(screen.getByText(ERROR_MESSAGES.NAME_REQUIRED)).toBeInTheDocument();
  });

  it('counts characters against the title and description limits', () => {
    mockFetch([]);
    renderCreateForm();

    expect(screen.getByText(`0/${STREAM_LIMITS.TITLE_MAX}`)).toBeInTheDocument();
    expect(
      screen.getByText(`0/${STREAM_LIMITS.DESCRIPTION_MAX}`),
    ).toBeInTheDocument();

    typeIn('Stream Name *', 'abcde');
    typeIn('Description *', 'abc');

    expect(screen.getByText(`5/${STREAM_LIMITS.TITLE_MAX}`)).toBeInTheDocument();
    expect(
      screen.getByText(`3/${STREAM_LIMITS.DESCRIPTION_MAX}`),
    ).toBeInTheDocument();

    // The inputs also stop the operator at the limit rather than failing later.
    expect(screen.getByLabelText('Stream Name *')).toHaveAttribute(
      'maxlength',
      String(STREAM_LIMITS.TITLE_MAX),
    );
    expect(screen.getByLabelText('Description *')).toHaveAttribute(
      'maxlength',
      String(STREAM_LIMITS.DESCRIPTION_MAX),
    );
  });

  it('submits the trimmed values and then the picked thumbnail', async () => {
    const created = makeStream({ id: 'new-id', title: 'Pilot keynote' });
    const calls: { url: string; method: string }[] = [];
    mockFetch([
      {
        method: 'POST',
        path: '/api/streams',
        respond: (init) => {
          calls.push({ url: '/api/streams', method: 'POST' });
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.title).toBe('Pilot keynote');
          expect(body.description).toBe('The opening talk');
          expect(body.mediaType).toBe('audio');
          expect(body.tags).toEqual(['eth']);
          expect(typeof body.scheduledStartTime).toBe('string');
          return jsonOk(created, 201);
        },
      },
      {
        method: 'PUT',
        path: '/api/streams/new-id/thumbnail',
        respond: (init) => {
          calls.push({ url: '/api/streams/new-id/thumbnail', method: 'PUT' });
          expect(
            (init?.headers as Record<string, string>)['content-type'],
          ).toBe('image/png');
          return jsonOk({ ...created, hasThumbnail: true });
        },
      },
    ]);

    renderCreateForm();

    typeIn('Stream Name *', '  Pilot keynote  ');
    typeIn('Description *', 'The opening talk');
    typeIn('Tags', 'eth');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Audio Only' }));
    typeIn('Scheduled Start Time *', '2026-10-01T18:00');
    fireEvent.change(screen.getByLabelText('Upload Thumbnail (Max 5MB)'), {
      target: { files: [fakeImage('cover.png', 1024)] },
    });

    submit();

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[1]!.method).toBe('PUT');
    expect(await screen.findByText('details page')).toBeInTheDocument();
  });

  it('keeps going when the stream saves but the thumbnail does not', async () => {
    const created = makeStream({ id: 'new-id', title: 'Pilot keynote' });
    mockFetch([
      {
        method: 'POST',
        path: '/api/streams',
        respond: () => jsonOk(created, 201),
      },
      {
        method: 'PUT',
        path: '/api/streams/new-id/thumbnail',
        respond: () => jsonError(413, {}),
      },
    ]);

    renderCreateForm();

    typeIn('Stream Name *', 'Pilot keynote');
    typeIn('Description *', 'The opening talk');
    typeIn('Scheduled Start Time *', '2026-10-01T18:00');
    fireEvent.change(screen.getByLabelText('Upload Thumbnail (Max 5MB)'), {
      target: { files: [fakeImage('cover.png', 1024)] },
    });

    submit();

    // The row exists, so the operator must land on it rather than be sent
    // back to a form that would create a second stream.
    expect(await screen.findByText('details page')).toBeInTheDocument();
    expect(
      screen.getByText(/Stream saved, but the thumbnail did not/),
    ).toBeInTheDocument();
  });

  it('locks the media type once the stream is published', async () => {
    mockFetch([
      {
        path: '/api/streams/pub-id',
        respond: () =>
          jsonOk(
            makeStream({
              id: 'pub-id',
              status: 'published',
              mediaType: 'video',
            }),
          ),
      },
    ]);

    renderEditForm('pub-id');

    expect(await screen.findByLabelText('Stream Name *')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Video Stream' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Audio Only' })).toBeDisabled();
    expect(screen.getByText(MEDIA_TYPE_LOCKED)).toBeInTheDocument();
    // Everything else stays editable: only the ingest stream id is at stake.
    expect(screen.getByLabelText('Stream Name *')).toBeEnabled();
    expect(screen.getByLabelText('Tags')).toBeEnabled();
  });

  it('locks the schedule, but nothing else, once the stream has gone live', async () => {
    // The time is a promise viewers have already read off the catalogue entry,
    // and the stream has kept or broken it. The backend refuses the change
    // with 409 stream_locked; the field says so before it is typed into.
    mockFetch([
      {
        path: '/api/streams/live-id',
        respond: () =>
          jsonOk(
            makeStream({
              id: 'live-id',
              status: 'live',
              liveSince: '2026-10-01T09:01:00.000Z',
            }),
          ),
      },
    ]);

    renderEditForm('live-id');

    expect(await screen.findByLabelText('Scheduled Start Time *')).toBeDisabled();
    expect(screen.getByText(SCHEDULE_LOCKED)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Audio Only' })).toBeDisabled();
    // A typo in a title is worth fixing mid-broadcast.
    expect(screen.getByLabelText('Stream Name *')).toBeEnabled();
    expect(screen.getByLabelText('Description *')).toBeEnabled();
    expect(screen.getByLabelText('Tags')).toBeEnabled();
  });

  it('leaves the schedule editable while the stream is only published', async () => {
    mockFetch([
      {
        path: '/api/streams/pub-2',
        respond: () =>
          jsonOk(makeStream({ id: 'pub-2', status: 'published' })),
      },
    ]);

    renderEditForm('pub-2');

    expect(await screen.findByLabelText('Scheduled Start Time *')).toBeEnabled();
    expect(screen.queryByText(SCHEDULE_LOCKED)).not.toBeInTheDocument();
  });

  it('leaves the media type editable while the stream is a draft', async () => {
    mockFetch([
      {
        path: '/api/streams/draft-id',
        respond: () =>
          jsonOk(makeStream({ id: 'draft-id', status: 'draft' })),
      },
    ]);

    renderEditForm('draft-id');

    expect(
      await screen.findByRole('radio', { name: 'Audio Only' }),
    ).toBeEnabled();
    expect(screen.queryByText(MEDIA_TYPE_LOCKED)).not.toBeInTheDocument();
  });

  it('prefills the form and the stored thumbnail when editing', async () => {
    const stream = makeStream({
      id: 'edit-id',
      title: 'Existing stream',
      description: 'Existing description',
      tags: ['a', 'b'],
      mediaType: 'audio',
      hasThumbnail: true,
    });
    mockFetch([
      { path: '/api/streams/edit-id', respond: () => jsonOk(stream) },
    ]);

    renderEditForm('edit-id');

    expect(await screen.findByDisplayValue('Existing stream')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Existing description')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Audio Only' })).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Update Stream' }),
    ).toBeInTheDocument();
    // The stored image is served by the API, cache-busted with updatedAt.
    expect(
      screen.getByAltText('Thumbnail preview').getAttribute('src'),
    ).toContain('/api/streams/edit-id/thumbnail?v=');
  });
});

describe('StreamFormPage tags', () => {
  it('adds a tag on Enter and drops duplicates', () => {
    mockFetch([]);
    renderCreateForm();

    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: 'pilot' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('pilot')).toBeInTheDocument();
    expect(screen.getByText(`1/${STREAM_LIMITS.TAGS_MAX} tags`)).toBeInTheDocument();

    // Same tag again: the box clears, the chip count does not move.
    fireEvent.change(input, { target: { value: 'pilot' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getAllByText('pilot')).toHaveLength(1);
    expect(screen.getByText(`1/${STREAM_LIMITS.TAGS_MAX} tags`)).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('caps a tag at 20 characters', () => {
    mockFetch([]);
    renderCreateForm();

    expect(screen.getByLabelText('Tags')).toHaveAttribute(
      'maxlength',
      String(STREAM_LIMITS.TAG_MAX_LENGTH),
    );
  });

  it('stops at ten tags', () => {
    mockFetch([]);
    renderCreateForm();

    const input = screen.getByLabelText('Tags');
    for (let i = 0; i < STREAM_LIMITS.TAGS_MAX; i += 1) {
      fireEvent.change(input, { target: { value: `tag${i}` } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }

    expect(
      screen.getByText(`${STREAM_LIMITS.TAGS_MAX}/${STREAM_LIMITS.TAGS_MAX} tags`),
    ).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute(
      'placeholder',
      `Maximum ${STREAM_LIMITS.TAGS_MAX} tags reached`,
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('removes a tag from its chip', () => {
    mockFetch([]);
    renderCreateForm();

    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: 'pilot' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.click(screen.getByLabelText('Remove tag pilot'));

    expect(screen.queryByText('pilot')).not.toBeInTheDocument();
    expect(screen.getByText(`0/${STREAM_LIMITS.TAGS_MAX} tags`)).toBeInTheDocument();
  });
});

describe('StreamFormPage thumbnail', () => {
  it('rejects an image over 5MB and keeps it out of the form', () => {
    mockFetch([]);
    renderCreateForm();

    const input = screen.getByLabelText('Upload Thumbnail (Max 5MB)');
    fireEvent.change(input, {
      target: {
        files: [
          fakeImage('huge.png', STREAM_LIMITS.THUMBNAIL_MAX_BYTES + 1),
        ],
      },
    });

    expect(
      screen.getByText(ERROR_MESSAGES.THUMBNAIL_TOO_LARGE),
    ).toBeInTheDocument();
    expect(screen.queryByText('huge.png')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();
  });

  it('offers only the types the backend accepts', () => {
    mockFetch([]);
    renderCreateForm();

    // image/* would let the picker offer SVG and HEIC, which the thumbnail
    // endpoint answers with a 415 after the row has already been saved.
    expect(
      screen.getByLabelText('Upload Thumbnail (Max 5MB)'),
    ).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
  });

  it('rejects a type the backend would answer with a 415', () => {
    mockFetch([]);
    renderCreateForm();

    // "All files" in the OS picker bypasses `accept`, so the type is checked
    // here too.
    fireEvent.change(screen.getByLabelText('Upload Thumbnail (Max 5MB)'), {
      target: { files: [fakeImage('logo.svg', 1024, 'image/svg+xml')] },
    });

    expect(screen.getByText(UNSUPPORTED_IMAGE_TYPE)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();
  });

  it('accepts an image exactly at the limit', () => {
    mockFetch([]);
    renderCreateForm();

    fireEvent.change(screen.getByLabelText('Upload Thumbnail (Max 5MB)'), {
      target: {
        files: [fakeImage('exact.png', STREAM_LIMITS.THUMBNAIL_MAX_BYTES)],
      },
    });

    expect(
      screen.queryByText(ERROR_MESSAGES.THUMBNAIL_TOO_LARGE),
    ).not.toBeInTheDocument();
    expect(screen.getByText('exact.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});
