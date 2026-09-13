import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  IngestPanel,
  KEY_UNVERIFIED_NOTE,
} from '../components/IngestPanel';
import { makeIngest, mockFetch, renderWithProviders } from './helpers';

describe('IngestPanel', () => {
  it('warns that the key is not verified yet', () => {
    mockFetch([]);
    const details = makeIngest({ keyVerified: false });

    renderWithProviders(
      <IngestPanel
        streamId="stream-1"
        details={details}
        onRotated={vi.fn()}
      />,
    );

    expect(screen.getByText(KEY_UNVERIFIED_NOTE)).toBeInTheDocument();
    // The note is the spec's copy, verbatim.
    expect(KEY_UNVERIFIED_NOTE).toBe(
      'The ingest does not verify this key yet. Anyone with the SRT passphrase can publish under this name until the uploader is upgraded.',
    );
  });

  it('drops the warning once the ingest verifies the key', () => {
    mockFetch([]);

    renderWithProviders(
      <IngestPanel
        streamId="stream-1"
        details={makeIngest({ keyVerified: true })}
        onRotated={vi.fn()}
      />,
    );

    expect(screen.queryByText(KEY_UNVERIFIED_NOTE)).not.toBeInTheDocument();
  });

  it('shows every value the encoder needs, with copy buttons', () => {
    mockFetch([]);
    const details = makeIngest();

    renderWithProviders(
      <IngestPanel
        streamId="stream-1"
        details={details}
        onRotated={vi.fn()}
      />,
    );

    // The RTMP server carries no secret, so it is shown as-is.
    expect(screen.getByLabelText('RTMP Server')).toHaveValue(
      details.rtmp.server,
    );

    // Everything carrying `key=` starts masked — the SRT URL embeds the same
    // publish key as the RTMP stream key, so hiding only one would lie about
    // which values are safe to leave on screen. The rest of the URL stays
    // readable so the operator can still check host and port.
    for (const label of ['SRT URL', 'Your stream key']) {
      const shown = (screen.getByLabelText(label) as HTMLInputElement).value;
      expect(shown).toContain('key=••••••••');
      expect(shown).not.toContain(details.publishKey);
    }
    expect(
      (screen.getByLabelText('SRT URL') as HTMLInputElement).value,
    ).toContain('srt://ingest.example.test:10061');
    expect(screen.getByLabelText('SRT Passphrase')).not.toHaveValue(
      details.srt.passphrase!,
    );

    fireEvent.click(screen.getByLabelText('show your stream key'));
    expect(screen.getByLabelText('Your stream key')).toHaveValue(
      details.rtmp.streamKey,
    );

    fireEvent.click(screen.getByLabelText('show srt url'));
    expect(screen.getByLabelText('SRT URL')).toHaveValue(details.srt.url);

    expect(screen.getByLabelText('copy srt url')).toBeInTheDocument();
    expect(screen.getByLabelText('copy rtmp server')).toBeInTheDocument();
    expect(screen.getByLabelText('copy your stream key')).toBeInTheDocument();
    expect(screen.getByLabelText('copy srt passphrase')).toBeInTheDocument();
    expect(screen.getByText(/Ingest stream id video\//)).toBeInTheDocument();
  });

  it('says so when the server has no SRT passphrase', () => {
    mockFetch([]);

    renderWithProviders(
      <IngestPanel
        streamId="stream-1"
        details={makeIngest({
          srt: { url: 'srt://host:10061?streamid=x', passphrase: null },
        })}
        onRotated={vi.fn()}
      />,
    );

    expect(
      screen.getByText('No SRT passphrase is configured on this ingest server.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('SRT Passphrase')).not.toBeInTheDocument();
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
        respond: () =>
          ({ ok: true, status: 200, json: async () => rotated }) as Response,
      },
    ]);
    const onRotated = vi.fn();

    renderWithProviders(
      <IngestPanel
        streamId="stream-1"
        details={makeIngest()}
        onRotated={onRotated}
      />,
    );

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
