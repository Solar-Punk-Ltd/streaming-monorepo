import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_LIMITS } from '@streaming-monorepo/web2-admin-common';

import {
  MEDIA_TYPE_LOCKED,
  SCHEDULE_LOCKED,
  UNSUPPORTED_IMAGE_TYPE,
} from '../errors';
import { ScheduleField } from '../components/schedule/ScheduleField';
import { formatHumanDateTime } from '../dateUtil';
import { nextFullHour } from '../components/schedule/scheduleTime';
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

    typeIn('Stream Name *', 'Devcon keynote');
    submit();

    expect(
      screen.getByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).toBeInTheDocument();
  });

  it('requires a scheduled start time', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', 'Devcon keynote');
    typeIn('Description *', 'The opening talk');
    // The form arrives prefilled, so the only way to reach this error is to
    // empty the field by hand — which the operator can still do.
    typeIn('Scheduled Date *', '');
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
    const created = makeStream({ id: 'new-id', title: 'Devcon keynote' });
    const calls: { url: string; method: string }[] = [];
    mockFetch([
      {
        method: 'POST',
        path: '/api/streams',
        respond: (init) => {
          calls.push({ url: '/api/streams', method: 'POST' });
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.title).toBe('Devcon keynote');
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

    typeIn('Stream Name *', '  Devcon keynote  ');
    typeIn('Description *', 'The opening talk');
    typeIn('Tags', 'eth');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Audio Only' }));
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
    const created = makeStream({ id: 'new-id', title: 'Devcon keynote' });
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

    typeIn('Stream Name *', 'Devcon keynote');
    typeIn('Description *', 'The opening talk');
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

    expect(await screen.findByLabelText('Scheduled Date *')).toBeDisabled();
    expect(screen.getByLabelText('Scheduled Time *')).toBeDisabled();
    expect(screen.getByText(SCHEDULE_LOCKED)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Audio Only' })).toBeDisabled();
    // A typo in a title is worth fixing mid-broadcast.
    expect(screen.getByLabelText('Stream Name *')).toBeEnabled();
    expect(screen.getByLabelText('Description *')).toBeEnabled();
    expect(screen.getByLabelText('Tags')).toBeEnabled();
  });

  it('leaves the schedule open on a live stream that never had one', async () => {
    // A row the API created before a schedule was required. Locking the empty
    // field would make the stream uneditable: the form will not submit without
    // a time. The backend lets that first time through for the same reason.
    mockFetch([
      {
        path: '/api/streams/live-blank',
        respond: () =>
          jsonOk(
            makeStream({
              id: 'live-blank',
              status: 'live',
              scheduledStartTime: null,
              liveSince: '2026-10-01T09:01:00.000Z',
            }),
          ),
      },
    ]);

    renderEditForm('live-blank');

    expect(await screen.findByLabelText('Scheduled Date *')).toBeEnabled();
    expect(screen.getByLabelText('Scheduled Time *')).toBeEnabled();
    expect(screen.queryByText(SCHEDULE_LOCKED)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Audio Only' })).toBeDisabled();
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

    expect(await screen.findByLabelText('Scheduled Date *')).toBeEnabled();
    expect(screen.getByLabelText('Scheduled Time *')).toBeEnabled();
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
    fireEvent.change(input, { target: { value: 'devcon' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('devcon')).toBeInTheDocument();
    expect(screen.getByText(`1/${STREAM_LIMITS.TAGS_MAX} tags`)).toBeInTheDocument();

    // Same tag again: the box clears, the chip count does not move.
    fireEvent.change(input, { target: { value: 'devcon' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getAllByText('devcon')).toHaveLength(1);
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
    fireEvent.change(input, { target: { value: 'devcon' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.click(screen.getByLabelText('Remove tag devcon'));

    expect(screen.queryByText('devcon')).not.toBeInTheDocument();
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


/**
 * The schedule field is one control with three parts: the picker field, the
 * quick-pick chips and the caption. What it owes the form is a
 * `datetime-local` string out of `onChange`, and silence with its reason
 * showing when the stream is locked.
 */
describe('ScheduleField', () => {
  /** Monday 14 September 2026, 14:23 — so the next full hour is 15:00. */
  const NOW = new Date(2026, 8, 14, 14, 23, 0);

  beforeEach(() => {
    // Only Date is faked: the picker still needs real timers to open.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  function Harness({
    initial = '2026-09-14T15:00',
    disabled = false,
    helperText,
    onChange,
  }: {
    initial?: string;
    disabled?: boolean;
    helperText?: string;
    onChange: (value: string) => void;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <ScheduleField
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        disabled={disabled}
        helperText={helperText}
      />
    );
  }

  const renderField = (props: Partial<Parameters<typeof Harness>[0]> = {}) => {
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} {...props} />);
    return onChange;
  };

  const dateField = () =>
    screen.getByLabelText<HTMLInputElement>('Scheduled Date *');
  const timeField = () =>
    screen.getByLabelText<HTMLInputElement>('Scheduled Time *');

  /** Opens the time menu the way a mouse does, and hands back its options. */
  const openTimeMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    return screen.getAllByRole('option');
  };

  const typeTime = (text: string) =>
    fireEvent.change(timeField(), { target: { value: text } });

  it('shows the day and the time in their own fields, and both in the caption', () => {
    renderField();

    expect(dateField()).toHaveValue('14/09/2026');
    expect(timeField()).toHaveValue('15:00');
    expect(
      screen.getByText('14/09/2026 15:00 · in 37 minutes'),
    ).toBeInTheDocument();
  });

  it('shows the date as DD/MM/YYYY, with no weekday section', () => {
    // The weekday used to be an editable section of the field: typing in it
    // moved the value inside the week while the text stood still, so the form
    // stored a date nobody chose. There is no such section to type into now.
    renderField();

    expect(dateField().value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(dateField().value).not.toMatch(/[A-Za-z]/);
  });

  it('offers the quick picks that are still ahead', () => {
    const onChange = renderField();

    // 14:23 on a Monday: all four are in the future.
    expect(
      screen.getByRole('button', { name: 'Tonight 20:00' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow same time' }));

    expect(onChange).toHaveBeenLastCalledWith('2026-09-15T14:23');
    expect(dateField()).toHaveValue('15/09/2026');
    expect(timeField()).toHaveValue('14:23');
  });

  it('narrows the time menu to the hour that was typed', () => {
    renderField();

    typeTime('18');

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '18:00',
      '18:15',
      '18:30',
      '18:45',
    ]);
  });

  it('takes a time off the menu without touching the day', () => {
    const onChange = renderField();

    typeTime('18');
    fireEvent.click(screen.getByRole('option', { name: '18:30' }));

    expect(onChange).toHaveBeenLastCalledWith('2026-09-14T18:30');
  });

  it('accepts a typed time that is not on the quarter-hour grid', () => {
    // The menu is a convenience, not a constraint: a stream can start at 18:07
    // and 1807 is how an operator says so.
    const onChange = renderField();

    typeTime('1807');
    fireEvent.blur(timeField());

    expect(onChange).toHaveBeenLastCalledWith('2026-09-14T18:07');
  });

  it('keeps an off-grid time it was given, in the field and in the menu', () => {
    renderField({ initial: '2026-09-14T18:07' });

    expect(timeField()).toHaveValue('18:07');
    expect(openTimeMenu().map((o) => o.textContent)).toContain('18:07');
  });

  it('disables the slots today has already spent, and none on a later day', () => {
    renderField();

    const options = openTimeMenu();
    const byLabel = new Map(options.map((o) => [o.textContent, o]));
    // It is 14:23, so 09:00 has gone and 18:00 has not.
    expect(byLabel.get('09:00')).toHaveAttribute('aria-disabled', 'true');
    expect(byLabel.get('18:00')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves every slot open on a future day', () => {
    renderField({ initial: '2026-09-20T15:00' });

    const options = openTimeMenu();

    expect(
      options.filter((o) => o.getAttribute('aria-disabled') === 'true'),
    ).toHaveLength(0);
  });

  it('picks a day out of the popover calendar', async () => {
    const onChange = renderField();

    fireEvent.click(screen.getByRole('button', { name: /choose date/i }));
    const calendar = await screen.findByRole('dialog');
    fireEvent.click(within(calendar).getByRole('gridcell', { name: '20' }));

    // The day moves; the time the field already held stays put.
    expect(onChange).toHaveBeenLastCalledWith('2026-09-20T15:00');
  });

  it('fills the time itself when a day is chosen before one', async () => {
    // A single click on a date is a complete answer to the operator, so the
    // form must end up with a complete value rather than a half-filled one.
    const onChange = renderField({ initial: '' });

    fireEvent.click(screen.getByRole('button', { name: /choose date/i }));
    const calendar = await screen.findByRole('dialog');
    fireEvent.click(within(calendar).getByRole('gridcell', { name: '20' }));

    expect(onChange).toHaveBeenLastCalledWith('2026-09-20T00:00');
  });

  it('can be emptied, which is what makes the field fail validation', () => {
    const onChange = renderField();

    typeIn('Scheduled Date *', '');

    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('goes quiet, with its reason, when the stream is locked', () => {
    renderField({
      disabled: true,
      helperText: SCHEDULE_LOCKED,
      initial: '2026-09-14T09:00',
    });

    expect(dateField()).toBeDisabled();
    expect(timeField()).toBeDisabled();
    expect(screen.getByRole('button', { name: /choose date/i })).toBeDisabled();
    expect(screen.getByText(SCHEDULE_LOCKED)).toBeInTheDocument();
    // No shortcuts on a field nobody can change.
    expect(
      screen.queryByRole('button', { name: 'Tomorrow same time' }),
    ).not.toBeInTheDocument();
  });
});

describe('StreamFormPage schedule prefill', () => {
  /** `DD/MM/YYYY HH:mm` → the halves the two fields each show. */
  const halves = (date: Date) => formatHumanDateTime(date).split(' ');

  it('prefills a new stream with the next full hour', () => {
    mockFetch([]);
    renderCreateForm();

    const [day, time] = halves(nextFullHour(new Date()));
    expect(screen.getByLabelText('Scheduled Date *')).toHaveValue(day);
    expect(screen.getByLabelText('Scheduled Time *')).toHaveValue(time);
  });

  it('leaves an edited stream on the time it was given', async () => {
    const iso = '2026-10-01T18:00:00.000Z';
    mockFetch([
      {
        path: '/api/streams/edit-time',
        respond: () =>
          jsonOk(makeStream({ id: 'edit-time', scheduledStartTime: iso })),
      },
    ]);

    renderEditForm('edit-time');

    // Whatever the machine's zone, the field shows that instant in it — the
    // prefill must not have overwritten a stored time.
    const [day, time] = halves(new Date(iso));
    expect(await screen.findByLabelText('Scheduled Date *')).toHaveValue(day);
    expect(screen.getByLabelText('Scheduled Time *')).toHaveValue(time);
  });
});

describe('StreamFormPage error clearing', () => {
  it('drops the required-name error as soon as a name is typed', () => {
    mockFetch([]);
    renderCreateForm();

    submit();

    expect(screen.getByText(ERROR_MESSAGES.NAME_REQUIRED)).toBeInTheDocument();
    expect(screen.getByLabelText('Stream Name *')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    typeIn('Stream Name *', 'Alps 2');

    // The message was about the form as it was when Create was pressed;
    // leaving it up paints a filled field red and contradicts what the
    // operator is looking at.
    expect(
      screen.queryByText(ERROR_MESSAGES.NAME_REQUIRED),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Stream Name *')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
  });

  it('does not clear a message a different field still owns', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', 'Alps 2');
    submit();

    expect(
      screen.getByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).toBeInTheDocument();

    // Editing the tags does not answer the description.
    typeIn('Tags', 'alps');

    expect(
      screen.getByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).toBeInTheDocument();

    typeIn('Description *', 'Two nights on the Aletsch');

    expect(
      screen.queryByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).not.toBeInTheDocument();
  });

  it('validates again on the next submit', () => {
    mockFetch([]);
    renderCreateForm();

    typeIn('Stream Name *', 'Alps 2');
    submit();

    expect(
      screen.getByText(ERROR_MESSAGES.DESCRIPTION_REQUIRED),
    ).toBeInTheDocument();

    // Emptying the name again must bring its own error back, not the stale one.
    typeIn('Stream Name *', '');
    submit();

    expect(screen.getByText(ERROR_MESSAGES.NAME_REQUIRED)).toBeInTheDocument();
  });
});
