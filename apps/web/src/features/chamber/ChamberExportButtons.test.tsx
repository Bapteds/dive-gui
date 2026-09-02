import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * ChamberExportButtons tests. The export API is mocked; the tests cover the
 * states the user sees: disabled until a build exists, a click fetching the
 * right artifact and triggering the object-URL download, a failed download
 * leaving the buttons usable again, and the STEP button turning into a menu
 * with "Change rotational direction" when the STEP carries the real vanes.
 */

vi.mock('@/lib/api/chamber', () => ({
  getChamberExport: vi.fn(),
}));
vi.mock('@/components/ui/sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { getChamberExport } from '@/lib/api/chamber';
import { toast } from '@/components/ui/sonner';
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

  it('reports a successful download up via onDownloaded, but never a failed one', async () => {
    const onDownloaded = vi.fn();
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['solid chamber']));
    const { unmount } = render(<ChamberExportButtons hash={HASH} onDownloaded={onDownloaded} />);
    fireEvent.click(screen.getByRole('button', { name: 'STL' }));
    await waitFor(() => expect(onDownloaded).toHaveBeenCalledWith('stl'));
    unmount();

    onDownloaded.mockClear();
    vi.mocked(getChamberExport).mockRejectedValue(new Error('gone'));
    render(<ChamberExportButtons hash={HASH} onDownloaded={onDownloaded} />);
    fireEvent.click(screen.getByRole('button', { name: 'STL' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'STL' })).toBeEnabled());
    expect(onDownloaded).not.toHaveBeenCalled();
  });

  it('keeps STEP a plain download when the mirror option is not offered', async () => {
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['ISO-10303-21;']));
    render(<ChamberExportButtons hash={HASH} offerMirror={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledWith(HASH, 'step'));
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('offers "Change rotational direction" for a guide-vane build', async () => {
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['ISO-10303-21;']));
    render(<ChamberExportButtons hash={HASH} offerMirror />);

    await userEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Change rotational direction' }),
    );
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledWith(HASH, 'stepMirrored'));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock'));
  });

  it('still downloads the plain STEP from the vane-STEP menu', async () => {
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['ISO-10303-21;']));
    render(<ChamberExportButtons hash={HASH} offerMirror />);

    await userEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Download STEP' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledWith(HASH, 'step'));
  });

  it('warns about the generation wait once per build, not on re-downloads', async () => {
    vi.mocked(getChamberExport).mockResolvedValue(new Blob(['ISO-10303-21;']));
    render(<ChamberExportButtons hash={HASH} offerMirror />);

    await userEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Download STEP' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledTimes(1));

    // Second download of the same kind: served from the build cache — no toast.
    await userEvent.click(screen.getByRole('button', { name: 'STEP' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Download STEP' }));
    await waitFor(() => expect(getChamberExport).toHaveBeenCalledTimes(2));
    expect(toast.info).toHaveBeenCalledTimes(1);
  });
});
