import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * ChamberExportButtons tests. The export API is mocked; the tests cover the
 * three states the user sees: disabled until a build exists, a click fetching
 * the right artifact and triggering the object-URL download, and a failed
 * download leaving the buttons usable again.
 */

vi.mock('@/lib/api/chamber', () => ({
  getChamberExport: vi.fn(),
}));

import { getChamberExport } from '@/lib/api/chamber';
import { ChamberExportButtons } from './ChamberExportButtons';

const HASH = 'cafe0123deadbeef';
const LABELS = ['STL', 'STEP', 'OpenFOAM triSurface'];

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no object-URL implementation.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

describe('ChamberExportButtons', () => {
  it('disables all three exports until a build exists', () => {
    render(<ChamberExportButtons hash={null} />);
    for (const label of LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
  });

  it('enables the exports once a hash is set', () => {
    render(<ChamberExportButtons hash={HASH} />);
    for (const label of LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('downloads the requested kind as a transient object URL', async () => {
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['solid chamber']));
    render(<ChamberExportButtons hash={HASH} />);

    fireEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledWith(HASH, 'step'));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('recovers from a failed download (buttons usable again)', async () => {
    vi.mocked(getChamberExport).mockRejectedValue(new Error('gone'));
    render(<ChamberExportButtons hash={HASH} />);

    fireEvent.click(screen.getByRole('button', { name: 'STL' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'STL' })).toBeEnabled());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
