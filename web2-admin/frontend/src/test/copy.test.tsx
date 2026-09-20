import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ValueField } from '../components/ValueField';
import { mockFetch, renderWithProviders } from './helpers';

/**
 * `navigator.clipboard` exists only in a secure context and the console is
 * deployed over plain http, so the fallback is the path that runs in
 * production. jsdom provides neither `navigator.clipboard` nor
 * `document.execCommand`, which makes "no clipboard at all" the default here.
 */

const VALUE = 'srt://ingest.example.test:10061?streamid=x?key=abc123,m=publish';

function stubClipboard(writeText: (v: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  // `restoreMocks` does not undo defineProperty on navigator.
  Reflect.deleteProperty(navigator as object, 'clipboard');
  Reflect.deleteProperty(document as object, 'execCommand');
});

function render(secret = false) {
  mockFetch([]);
  return renderWithProviders(
    <ValueField label="SRT URL" value={VALUE} secret={secret} />,
  );
}

const clickCopy = () =>
  fireEvent.click(screen.getByLabelText('copy srt url'));

describe('copying a value', () => {
  it('uses the async clipboard when the page has one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render();

    clickCopy();

    expect(
      await screen.findByText('SRT URL copied to your clipboard.'),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(VALUE);
  });

  it('falls back to execCommand when navigator.clipboard is undefined', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });
    render();

    clickCopy();

    expect(
      await screen.findByText('SRT URL copied to your clipboard.'),
    ).toBeInTheDocument();
    expect(execCommand).toHaveBeenCalledWith('copy');
    // The value has to reach a real, selectable textarea for the command to
    // have anything to copy — and that node must not be left behind.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back to execCommand when the async clipboard rejects', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });
    render();

    clickCopy();

    expect(
      await screen.findByText('SRT URL copied to your clipboard.'),
    ).toBeInTheDocument();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('selects the value for a manual copy when neither route works', async () => {
    expect(navigator.clipboard).toBeUndefined();
    expect(typeof document.execCommand).toBe('undefined');
    render();

    clickCopy();

    expect(
      await screen.findByText(/The srt url is selected — copy it with your keyboard/),
    ).toBeInTheDocument();
    const field = screen.getByLabelText<HTMLInputElement>('SRT URL');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(VALUE.length);
  });

  it('reveals a secret before selecting it, so the mask is not what gets copied', async () => {
    render(true);

    // Hidden to start with.
    expect(screen.getByLabelText<HTMLInputElement>('SRT URL').value).not.toBe(
      VALUE,
    );

    clickCopy();

    await waitFor(() => {
      const field = screen.getByLabelText<HTMLInputElement>('SRT URL');
      expect(field.value).toBe(VALUE);
      expect(field.selectionEnd).toBe(VALUE.length);
    });
  });
});
