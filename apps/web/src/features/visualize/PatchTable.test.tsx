import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MeshPatch } from '@/lib/api/types';
import { PatchTable } from './PatchTable';

/**
 * PatchTable tests: the Name/Type/nFaces list renders, rows are selectable (and
 * toggle off), the selected row is marked aria-selected, and "Show all" clears
 * the selection (and is disabled when nothing is selected).
 */

const patches: MeshPatch[] = [
  { name: 'inlet', type: 'patch', nFaces: 1200 },
  { name: 'walls', type: 'wall', nFaces: 65000 },
];

describe('PatchTable', () => {
  it('renders a row per patch with a locale-formatted face count', () => {
    render(<PatchTable patches={patches} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('inlet')).toBeInTheDocument();
    expect(screen.getByText('walls')).toBeInTheDocument();
    expect(screen.getByText('wall')).toBeInTheDocument();
    expect(screen.getByText('65,000')).toBeInTheDocument();
  });

  it('selects a patch when its row is clicked', () => {
    const onSelect = vi.fn();
    render(<PatchTable patches={patches} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('walls'));
    expect(onSelect).toHaveBeenCalledWith('walls');
  });

  it('toggles a selected patch off when its row is clicked again', () => {
    const onSelect = vi.fn();
    render(<PatchTable patches={patches} selected="walls" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('walls'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks the selected row with aria-selected', () => {
    render(<PatchTable patches={patches} selected="walls" onSelect={() => {}} />);
    const selectedRow = screen.getByText('walls').closest('tr');
    expect(selectedRow).toHaveAttribute('aria-selected', 'true');
    const otherRow = screen.getByText('inlet').closest('tr');
    expect(otherRow).toHaveAttribute('aria-selected', 'false');
  });

  it('exposes a per-row rename action that does not select the row', () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    render(
      <PatchTable patches={patches} selected={null} onSelect={onSelect} onRename={onRename} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename walls' }));
    expect(onRename).toHaveBeenCalledWith('walls');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides the rename action when onRename is not provided', () => {
    render(<PatchTable patches={patches} selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('disables "Show all" until something is selected, then clears the selection', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <PatchTable patches={patches} selected={null} onSelect={onSelect} />,
    );
    const showAll = screen.getByRole('button', { name: /show all/i });
    expect(showAll).toBeDisabled();

    rerender(<PatchTable patches={patches} selected="inlet" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /show all/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
