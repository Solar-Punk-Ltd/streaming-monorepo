import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IngestPanel,
  NO_STAGE_NOTE,
  RETIRED_STAGE_NOTE,
  RTMP_INTRO_NOTE,
  rtmpUnencryptedNote,
} from '../components/IngestPanel';
import { RTMP_OFFERED, makeIngest, mockFetch, renderWithProviders } from './helpers';

const renderPanel = (details = makeIngest()) =>
  renderWithProviders(<IngestPanel streamId="stream-1" details={details} onRotated={vi.fn()} />);

const section = (name: 'SRT Connection' | 'RTMP') => within(screen.getByRole('region', { name }));

const otherProtocols = () => screen.getByRole('button', { name: 'Other protocols' });

/** Opens the Other protocols section, which every panel starts with folded. */
const openOtherProtocols = () => {
  fireEvent.click(otherProtocols());
  expect(otherProtocols()).toHaveAttribute('aria-expanded', 'true');
};

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
    expect(screen.getByRole('region', { name: 'SRT Connection' })).toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for SRT', () => {
    mockFetch([]);
    const details = makeIngest();
    const server = `${details.srt!.url}&passphrase=${details.srt!.passphrase}`;

    renderPanel(details);

    expect(screen.getByText(/set Service to Custom/)).toBeInTheDocument();
    const srt = section('SRT Connection');

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

  it('shows SRT alone on a stage that takes no RTMP, with no Other protocols section', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: null }));

    expect(screen.getByRole('region', { name: 'SRT Connection' })).toBeInTheDocument();
    expect(screen.getByText(/copy the SRT values below into OBS/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Other protocols' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other protocols' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Other protocols/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RTMP/)).not.toBeInTheDocument();
  });

  it('keeps RTMP folded under Other protocols, after SRT, where the stage takes it', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: RTMP_OFFERED }));

    expect(screen.getByRole('region', { name: 'SRT Connection' })).toBeInTheDocument();
    expect(screen.getByText(/copy the SRT values below into OBS/)).toHaveTextContent(RTMP_INTRO_NOTE);
    expect(screen.getByRole('region', { name: 'Other protocols' })).toBeInTheDocument();
    expect(otherProtocols()).toHaveAttribute('aria-expanded', 'false');

    // Folded, the section holds nothing: no RTMP values, and no key, are in the page.
    expect(screen.queryByRole('region', { name: 'RTMP' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('RTMP Server')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('RTMP Stream Key')).not.toBeInTheDocument();
    expect(screen.queryByText(/RTMP is not encrypted/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RTMP_OFFERED.server);
    expect(document.body.innerHTML).not.toContain(RTMP_OFFERED.streamKey);
  });

  it('starts Other protocols folded each time the panel opens', () => {
    mockFetch([]);
    const details = makeIngest({ rtmp: RTMP_OFFERED });

    const first = renderPanel(details);
    openOtherProtocols();
    expect(screen.getByLabelText('RTMP Server')).toBeInTheDocument();
    first.unmount();

    renderPanel(details);
    expect(otherProtocols()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('RTMP Server')).not.toBeInTheDocument();
  });

  it('warns beside RTMP that it is not encrypted, what a key read off the network allows, and what SRT keeps', () => {
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: RTMP_OFFERED }));
    openOtherProtocols();

    const warning = section('RTMP').getByText(rtmpUnencryptedNote(true));
    expect(warning).toHaveTextContent(/RTMP is not encrypted/);
    expect(warning).toHaveTextContent(/publishes to this stream over RTMP/);
    expect(warning).toHaveTextContent(/replace your live broadcast/);
    expect(warning).toHaveTextContent(/keeps your picture private but not your key/);
    expect(warning).toHaveTextContent(/whichever protocol it was read from/);
    expect(section('SRT Connection').queryByText(/RTMP is not encrypted/)).not.toBeInTheDocument();
  });

  it('does not recommend an SRT passphrase beside RTMP on a stage that has none', () => {
    mockFetch([]);
    const details = makeIngest({ rtmp: RTMP_OFFERED });

    renderPanel({ ...details, srt: { ...details.srt!, passphrase: null } });
    openOtherProtocols();

    const warning = section('RTMP').getByText(rtmpUnencryptedNote(false));
    expect(warning).toHaveTextContent(/has no SRT passphrase, so the picture is not private either/);
    expect(warning).not.toHaveTextContent(/keeps your picture private/);
    expect(section('SRT Connection').getByText('No SRT passphrase is configured on this stage.')).toBeInTheDocument();
  });

  it('says what goes in the OBS Server and Stream Key boxes for RTMP once Other protocols is opened', () => {
    mockFetch([]);
    const details = makeIngest({ rtmp: RTMP_OFFERED });

    renderPanel(details);
    openOtherProtocols();
    const rtmp = section('RTMP');

    // The RTMP server carries no secret, so it is shown as-is.
    expect(rtmp.getByLabelText('RTMP Server')).toHaveValue(RTMP_OFFERED.server);
    expect(rtmp.getByText('Paste into the Server box.')).toBeInTheDocument();

    const key = shownValue('RTMP Stream Key');
    expect(key).toContain('key=••••••••');
    expect(key).not.toContain(details.publishKey);
    expect(rtmp.getByText('Paste into the Stream Key box.')).toBeInTheDocument();
    fireEvent.click(rtmp.getByLabelText('show rtmp stream key'));
    expect(rtmp.getByLabelText('RTMP Stream Key')).toHaveValue(RTMP_OFFERED.streamKey);

    expect(rtmp.getByLabelText('copy rtmp server')).toBeInTheDocument();
    expect(rtmp.getByLabelText('copy rtmp stream key')).toBeInTheDocument();
  });

  it('copies the real RTMP stream key while it is masked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mockFetch([]);

    renderPanel(makeIngest({ rtmp: RTMP_OFFERED }));
    openOtherProtocols();
    fireEvent.click(screen.getByLabelText('copy rtmp stream key'));

    expect(await screen.findByText('RTMP Stream Key copied to your clipboard.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(RTMP_OFFERED.streamKey);
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
    const srt = section('SRT Connection');

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
    const srt = section('SRT Connection');

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

  it('heads the SRT settings "SRT Connection", and offers Rotate key but no Finalize', () => {
    mockFetch([]);

    renderPanel();

    const srt = section('SRT Connection');
    expect(screen.getByText('SRT Connection')).toBeInTheDocument();
    // OBS still shows a Stream Key box, and it must stay empty.
    expect(srt.getByText(/leave it empty/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rotate key/ })).toBeInTheDocument();
    // Finalize lives in the stream's status notice, not here.
    expect(screen.queryByRole('button', { name: /Finali[sz]e|Finish/ })).not.toBeInTheDocument();
  });
});
