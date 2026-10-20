import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusChip } from '../components/StatusChip';
import { mockFetch, renderWithProviders } from './helpers';

describe('StatusChip', () => {
  it('says what VOD stands for on hover', async () => {
    mockFetch([]);

    renderWithProviders(<StatusChip status="vod" />);
    fireEvent.mouseOver(screen.getByText('VOD'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Video On Demand');
  });

  it('explains no other status on hover', async () => {
    mockFetch([]);

    renderWithProviders(
      <>
        <StatusChip status="draft" />
        <StatusChip status="publishing" />
        <StatusChip status="published" />
        <StatusChip status="live" />
      </>,
    );
    for (const label of ['Draft', 'Publishing', 'Published', 'Live']) {
      fireEvent.mouseOver(screen.getByText(label));
    }

    // A tooltip opens 100 ms after the pointer arrives, so one would be open by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
