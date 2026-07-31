import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { computeChamberOutputs } from '@dive/shared';
import { ChamberOutputsTable } from './ChamberOutputsTable';

/**
 * ChamberOutputsTable tests: the twelve computed parameters render with their
 * FINAL and status, an empty (null) outputs state prompts for inputs, and
 * editing a Min / Max / Exact cell reports the change up (the parent owns the
 * constraints + live recompute).
 */

const OUTPUTS = computeChamberOutputs({ x1: 1450, x2: 7.85, x3: 8 });

describe('ChamberOutputsTable', () => {
  it('prompts for inputs when there are no outputs', () => {
    render(<ChamberOutputsTable outputs={null} constraints={{}} onConstraintChange={() => {}} />);
    expect(screen.getByText(/enter valid inputs/i)).toBeInTheDocument();
  });

  it('renders a row per output with its label and within-range status', () => {
    render(<ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />);
    expect(screen.getByText('Width')).toBeInTheDocument();
    expect(screen.getByText('Last cylinder diameter')).toBeInTheDocument();
    // 11 fitted outputs read "within range"; Height is the derived P11 + P12 identity.
    expect(screen.getAllByText('within range')).toHaveLength(OUTPUTS.length - 1);
    expect(screen.getByText('= P11 + P12')).toBeInTheDocument();
  });

  it('reports a Min edit up as a numeric constraint change', () => {
    const onChange = vi.fn();
    render(<ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Width minimum'), { target: { value: '4000' } });
    expect(onChange).toHaveBeenCalledWith('width', 'min', 4000);
  });

  it('clears a constraint when its cell is emptied', () => {
    const onChange = vi.fn();
    render(
      <ChamberOutputsTable
        outputs={OUTPUTS}
        constraints={{ width: { min: 4000 } }}
        onConstraintChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Width minimum'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('width', 'min', undefined);
  });
});
