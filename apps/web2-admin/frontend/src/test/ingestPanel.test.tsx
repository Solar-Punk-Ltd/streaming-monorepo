import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestPanel, NO_STAGE_NOTE, RETIRED_STAGE_NOTE } from '../components/IngestPanel';
import { RTMP_OFFERED, makeIngest, mockFetch, renderWithProviders } from './helpers';

const renderPanel = (details = makeIngest()) =>
  renderWithProviders(<IngestPanel streamId="stream-1" details={details} onRotated={vi.fn()} />);

const section = (name: 'SRT' | 'RTMP') => within(screen.getByRole('region', { name }));

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

  it('offers SRT alone where the deployment keeps RTMP closed', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: null }));

    expect(screen.getByRole('region', { name: 'SRT' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'RTMP' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('RTMP Stream Key')).not.toBeInTheDocument();
    expect(screen.queryByText(/pick one of the two protocols/)).not.toBeInTheDocument();
    expect(screen.getByText(/copy the SRT values below into OBS/)).toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for RTMP where the deployment opens it', () => {
    mockFetch([]);
    const details = makeIngest({ rtmp: RTMP_OFFERED });

    renderPanel(details);
    expect(screen.getByText(/pick one of the two protocols/)).toBeInTheDocument();
    const rtmp = section('RTMP');

    // The RTMP server carries no secret, so it is shown as-is.
    expect(rtmp.getByLabelText('RTMP Server')).toHaveValue(RTMP_OFFERED.server);

    const key = shownValue('RTMP Stream Key');
    expect(key).toContain('key=••••••••');
    expect(key).not.toContain(details.publishKey);
    fireEvent.click(rtmp.getByLabelText('show rtmp stream key'));
    expect(rtmp.getByLabelText('RTMP Stream Key')).toHaveValue(RTMP_OFFERED.streamKey);

    expect(rtmp.getByLabelText('copy rtmp server')).toBeInTheDocument();
    expect(rtmp.getByLabelText('copy rtmp stream key')).toBeInTheDocument();
    expect(screen.getByText(/Ingest stream id video\//)).toBeInTheDocument();
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
});
