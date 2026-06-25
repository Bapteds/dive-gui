import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MeshPatch } from '@/lib/api/types';
import { PatchTable } from './PatchTable';

/**
 * PatchTable tests: the read-only Name/Type/nFaces list renders, rows are
 * selectable (and toggle off), the selected row is marked aria-selected, and the
 * type shows as plain text (editing happens in the overlay, not inline). "Show
 * all" lives in the toolbar above the table, not in this component.
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

  it('is read-only with no inline edit controls or toolbar buttons', () => {
    render(<PatchTable patches={patches} selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
    expect(screen.getByText('patch')).toBeInTheDocument();
  });
});
