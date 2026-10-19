import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamFinishAnswer } from '@streaming-monorepo/web2-admin-common';

import { IngestPanel, NO_STAGE_NOTE, RETIRED_STAGE_NOTE } from '../components/IngestPanel';
import {
  RTMP_OFFERED,
  jsonError,
  jsonOk,
  makeIngest,
  makeStream,
  mockFetch,
  type Route as MockRoute,
  renderWithProviders,
} from './helpers';

const renderPanel = (details = makeIngest()) =>
  renderWithProviders(<IngestPanel streamId="stream-1" details={details} onRotated={vi.fn()} />);

/** The panel as the stream page shows it on a live or ended stream that is not finished yet. */
const renderFinishable = ({ live = false, onRotated = vi.fn(), onFinished = vi.fn(), onRefused = vi.fn() } = {}) =>
  renderWithProviders(
    <IngestPanel
      streamId="stream-1"
      details={makeIngest()}
      onRotated={onRotated}
      finish={{ live, onFinished, onRefused }}
    />,
  );

const FINISH_WARNING =
  'Its key changes now, so no encoder can start it again on the old key. To go live on it later on purpose, copy ' +
  'the new SRT line.';

const LIVE_FINISH_WARNING = 'The broadcast carries on until the encoder stops; then it ends for good.';

const section = (name: 'SRT') => within(screen.getByRole('region', { name }));

const shownValue = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

afterEach(() => {
  // `restoreMocks` does not undo defineProperty on navigator.
  Reflect.deleteProperty(navigator as object, 'clipboard');
});

describe('IngestPanel', () => {
  it('says which stage the details are from, and carries no note about the key', () => {
    mockFetch([]);

    renderPanel();

    expect(screen.getByText('Main stage')).toBeInTheDocument();
    expect(screen.getByText(/On stage/)).toBeInTheDocument();
    // Every uploader that takes streams from the admin verifies `key=`.
    expect(screen.queryByText(/does not verify this key/)).not.toBeInTheDocument();
    expect(screen.queryByText(RETIRED_STAGE_NOTE)).not.toBeInTheDocument();
  });

  it('says to pick a stage while the stream has none, and still offers the key rotation', () => {
    mockFetch([]);

    renderPanel(makeIngest({ stage: null, srt: null, rtmp: null }));

    expect(screen.getByText(NO_STAGE_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'SRT' })).not.toBeInTheDocument();
    expect(screen.queryByText(/set Service to Custom/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rotate key/ })).toBeInTheDocument();
    expect(screen.getByText(/Ingest stream id video\//)).toBeInTheDocument();
  });

  it('keeps the details of a stage the manager retired, with a warning', () => {
    mockFetch([]);

    renderPanel(
      makeIngest({ stage: { stageId: 'retired-stage', name: 'Old stage', retiredAt: '2026-09-28T11:00:00.000Z' } }),
    );

    expect(screen.getByText(RETIRED_STAGE_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'SRT' })).toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for SRT', () => {
    mockFetch([]);
    const details = makeIngest();
    const server = `${details.srt!.url}&passphrase=${details.srt!.passphrase}`;

    renderPanel(details);

    expect(screen.getByText(/set Service to Custom/)).toBeInTheDocument();
    const srt = section('SRT');

    // One line carries the stream id, the key and the passphrase. Both
    // secrets start masked, while host and port stay readable.
    const shown = shownValue('SRT Server');
    expect(shown).toContain('srt://ingest.example.test:10061');
    expect(shown).toContain('key=••••••••');
    expect(shown).toContain('passphrase=••••••••');
    expect(shown).not.toContain(details.publishKey);
    expect(shown).not.toContain(details.srt!.passphrase!);

    fireEvent.click(srt.getByLabelText('show srt server'));
    expect(srt.getByLabelText('SRT Server')).toHaveValue(server);

    // OBS's Stream Key box becomes the SRT stream id, so it stays empty.
    expect(srt.getByText(/Stream Key/)).toBeInTheDocument();
    expect(srt.getByText(/leave it empty/)).toBeInTheDocument();
    expect(srt.queryByLabelText('SRT Password')).not.toBeInTheDocument();
    expect(srt.getByLabelText('copy srt server')).toBeInTheDocument();
  });

  it('shows SRT and no RTMP, even where the stage takes RTMP and the API sends its details', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: RTMP_OFFERED }));

    expect(screen.getByRole('region', { name: 'SRT' })).toBeInTheDocument();
    expect(screen.getByText(/copy the SRT values below into OBS/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'RTMP' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('RTMP Server')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('RTMP Stream Key')).not.toBeInTheDocument();
    expect(screen.queryByText(/pick one of the two protocols/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RTMP/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(RTMP_OFFERED.server)).not.toBeInTheDocument();
  });

  it('shows SRT alone on a stage that takes no RTMP', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: null }));

    expect(screen.getByRole('region', { name: 'SRT' })).toBeInTheDocument();
    expect(screen.getByText(/copy the SRT values below into OBS/)).toBeInTheDocument();
    expect(screen.queryByText(/RTMP/)).not.toBeInTheDocument();
  });

  it('copies the real SRT Server line while it is masked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mockFetch([]);
    const details = makeIngest();

    renderPanel(details);
    fireEvent.click(screen.getByLabelText('copy srt server'));

    expect(await screen.findByText('SRT Server copied to your clipboard.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`${details.srt!.url}&passphrase=${details.srt!.passphrase}`);
  });

  it('sends a passphrase the Server line cannot carry to Use authentication', () => {
    mockFetch([]);
    const passphrase = 'has+plus&and0123';
    const details = makeIngest({
      srt: { url: makeIngest().srt!.url, passphrase },
    });

    renderPanel(details);
    const srt = section('SRT');

    fireEvent.click(srt.getByLabelText('show srt server'));
    expect(srt.getByLabelText('SRT Server')).toHaveValue(details.srt!.url);

    expect(srt.getByLabelText('SRT Password')).not.toHaveValue(passphrase);
    expect(srt.getByText(/tick Use authentication/)).toBeInTheDocument();
    fireEvent.click(srt.getByLabelText('show srt password'));
    expect(srt.getByLabelText('SRT Password')).toHaveValue(passphrase);
  });

  it('says so when the stage has no SRT passphrase', () => {
    mockFetch([]);
    const url = 'srt://host:10061?streamid=x';

    renderPanel(makeIngest({ srt: { url, passphrase: null } }));
    const srt = section('SRT');

    expect(srt.getByText('No SRT passphrase is configured on this stage.')).toBeInTheDocument();
    fireEvent.click(srt.getByLabelText('show srt server'));
    expect(srt.getByLabelText('SRT Server')).toHaveValue(url);
    expect(srt.queryByLabelText('SRT Password')).not.toBeInTheDocument();
  });

  it('confirms before rotating the key and reports the new one', async () => {
    const rotated = makeIngest({
      publishKey: 'ffffffffffffffffffffffffffffffff',
      publishKeyRotatedAt: '2026-09-11T12:00:00.000Z',
    });
    mockFetch([
      {
        method: 'POST',
        path: '/api/streams/stream-1/ingest/rotate-key',
        respond: () => ({ ok: true, status: 200, json: async () => rotated }) as Response,
      },
    ]);
    const onRotated = vi.fn();

    renderWithProviders(<IngestPanel streamId="stream-1" details={makeIngest()} onRotated={onRotated} />);

    fireEvent.click(screen.getByRole('button', { name: /Rotate key/ }));
    expect(await screen.findByText(/current key stops working/)).toBeInTheDocument();

    // Two buttons carry that name now; the one inside the dialog confirms.
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Rotate key',
      }),
    );

    await screen.findByText('Stream key rotated. Update your encoder.');
    expect(onRotated).toHaveBeenCalledWith(rotated);
  });

  it('offers no Finish unless the page asks for it', () => {
    mockFetch([]);

    renderPanel();

    expect(screen.getByRole('button', { name: /Rotate key/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument();
  });

  it('confirms before finishing an ended stream, then hands on its new key and the finished stream', async () => {
    const answer = finishAnswer();
    const fetchMock = mockFetch([finishRoute(() => jsonOk(answer))]);
    const onRotated = vi.fn();
    const onFinished = vi.fn();

    renderFinishable({ onRotated, onFinished });

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Finish this stream?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(FINISH_WARNING);
    expect(dialog).not.toHaveTextContent(LIVE_FINISH_WARNING);
    expect(finishCalls(fetchMock)).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('Stream finished. Its key has changed.')).toBeInTheDocument();
    expect(finishCalls(fetchMock)).toBe(1);
    // The page shows the new SRT line from these, as after a rotation.
    expect(onRotated).toHaveBeenCalledWith(answer.ingest);
    expect(onFinished).toHaveBeenCalledWith(answer.stream);
  });

  it('says, before finishing a live stream, that its broadcast carries on until the encoder stops', async () => {
    mockFetch([]);

    renderFinishable({ live: true });

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(FINISH_WARNING);
    expect(dialog).toHaveTextContent(LIVE_FINISH_WARNING);
  });

  it.each([
    ['stream_not_started', 'Only a live or ended stream can be finished.'],
    ['stream_finished', 'This stream is already finished: its key has changed.'],
  ])(
    'answers a Finish refused with %s in its own words, closes, and has the page read the stream again',
    async (code, sentence) => {
      // A message of the API's own, to show that the console's sentence for the code wins.
      mockFetch([finishRoute(() => jsonError(409, { error: code, id: 'stream-1', message: 'Refused.' }))]);
      const onRotated = vi.fn();
      const onFinished = vi.fn();
      const onRefused = vi.fn();

      renderFinishable({ onRotated, onFinished, onRefused });

      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Finish' }));

      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText('Refused.')).not.toBeInTheDocument();
      // The stream is no longer where the page showed it, so asking again cannot help.
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(onRefused).toHaveBeenCalledTimes(1);
      expect(onRotated).not.toHaveBeenCalled();
      expect(onFinished).not.toHaveBeenCalled();
    },
  );

  it('keeps the dialog open after a failure that is no refusal, to retry or cancel, and reads nothing again', async () => {
    mockFetch([finishRoute(() => jsonError(500, { error: 'internal_error' }))]);
    const onRefused = vi.fn();

    renderFinishable({ onRefused });

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('The server hit an unexpected error.')).toBeInTheDocument();
    // MUI keeps a closing dialog on the page for its exit transition, so
    // "still there" proves nothing until that time has passed.
    await expect(
      waitFor(
        () => {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        },
        { timeout: 600 },
      ),
    ).rejects.toThrow();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish' })).toBeEnabled();
    expect(onRefused).not.toHaveBeenCalled();
  });
});

function finishRoute(respond: () => Response): MockRoute {
  return { method: 'POST', path: '/api/streams/stream-1/finish', respond };
}

/** The Finishes sent. The theme provider reads the console's config on its own, so not every call is one. */
function finishCalls(fetchMock: ReturnType<typeof mockFetch>): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === '/api/streams/stream-1/finish' && init?.method === 'POST',
  ).length;
}

/** The API's answer to a Finish: the stream as it now stands, and its details with the new key. */
function finishAnswer(): StreamFinishAnswer {
  const finishedAt = '2026-10-19T12:10:00.000Z';
  return {
    stream: makeStream({
      id: 'stream-1',
      status: 'vod',
      endedAt: '2026-10-19T12:00:00.000Z',
      finishedAt,
      restartUntil: null,
    }),
    ingest: makeIngest({ publishKey: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', publishKeyRotatedAt: finishedAt }),
  };
}
