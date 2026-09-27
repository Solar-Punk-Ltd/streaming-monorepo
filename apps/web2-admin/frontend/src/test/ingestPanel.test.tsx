import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IngestPanel, KEY_UNVERIFIED_NOTE } from '../components/IngestPanel';
import { makeIngest, mockFetch, renderWithProviders } from './helpers';

const renderPanel = (details = makeIngest()) =>
  renderWithProviders(<IngestPanel streamId="stream-1" details={details} onRotated={vi.fn()} />);

const section = (name: 'SRT' | 'RTMP') => within(screen.getByRole('region', { name }));

const shownValue = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

afterEach(() => {
  // `restoreMocks` does not undo defineProperty on navigator.
  Reflect.deleteProperty(navigator as object, 'clipboard');
});

describe('IngestPanel', () => {
  it('warns that the key is not verified yet', () => {
    mockFetch([]);
    const details = makeIngest({ keyVerified: false });

    renderWithProviders(<IngestPanel streamId="stream-1" details={details} onRotated={vi.fn()} />);

    expect(screen.getByText(KEY_UNVERIFIED_NOTE)).toBeInTheDocument();
    // The note is the spec's copy, verbatim.
    expect(KEY_UNVERIFIED_NOTE).toBe(
      'The ingest does not verify this key yet. Anyone with the SRT passphrase can publish under this name until the uploader is upgraded.',
    );
  });

  it('drops the warning once the ingest verifies the key', () => {
    mockFetch([]);

    renderWithProviders(
      <IngestPanel streamId="stream-1" details={makeIngest({ keyVerified: true })} onRotated={vi.fn()} />,
    );

    expect(screen.queryByText(KEY_UNVERIFIED_NOTE)).not.toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for SRT', () => {
    mockFetch([]);
    const details = makeIngest();
    const server = `${details.srt.url}&passphrase=${details.srt.passphrase}`;

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
    expect(shown).not.toContain(details.srt.passphrase!);

    fireEvent.click(srt.getByLabelText('show srt server'));
    expect(srt.getByLabelText('SRT Server')).toHaveValue(server);

    // OBS's Stream Key box becomes the SRT stream id, so it stays empty.
    expect(srt.getByText(/Stream Key/)).toBeInTheDocument();
    expect(srt.getByText(/leave it empty/)).toBeInTheDocument();
    expect(srt.queryByLabelText('SRT Password')).not.toBeInTheDocument();
    expect(srt.getByLabelText('copy srt server')).toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for RTMP', () => {
    mockFetch([]);
    const details = makeIngest();

    renderPanel(details);
    const rtmp = section('RTMP');

    // The RTMP server carries no secret, so it is shown as-is.
    expect(rtmp.getByLabelText('RTMP Server')).toHaveValue(details.rtmp.server);

    const key = shownValue('RTMP Stream Key');
    expect(key).toContain('key=••••••••');
    expect(key).not.toContain(details.publishKey);
    fireEvent.click(rtmp.getByLabelText('show rtmp stream key'));
    expect(rtmp.getByLabelText('RTMP Stream Key')).toHaveValue(details.rtmp.streamKey);

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
    expect(writeText).toHaveBeenCalledWith(`${details.srt.url}&passphrase=${details.srt.passphrase}`);
  });

  it('sends a passphrase the Server line cannot carry to Use authentication', () => {
    mockFetch([]);
    const passphrase = 'has+plus&and0123';
    const details = makeIngest({
      srt: { url: makeIngest().srt.url, passphrase },
    });

    renderPanel(details);
    const srt = section('SRT');

    fireEvent.click(srt.getByLabelText('show srt server'));
    expect(srt.getByLabelText('SRT Server')).toHaveValue(details.srt.url);

    expect(srt.getByLabelText('SRT Password')).not.toHaveValue(passphrase);
    expect(srt.getByText(/tick Use authentication/)).toBeInTheDocument();
    fireEvent.click(srt.getByLabelText('show srt password'));
    expect(srt.getByLabelText('SRT Password')).toHaveValue(passphrase);
  });

  it('says so when the server has no SRT passphrase', () => {
    mockFetch([]);
    const url = 'srt://host:10061?streamid=x';

    renderPanel(makeIngest({ srt: { url, passphrase: null } }));
    const srt = section('SRT');

    expect(srt.getByText('No SRT passphrase is configured on this ingest server.')).toBeInTheDocument();
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
