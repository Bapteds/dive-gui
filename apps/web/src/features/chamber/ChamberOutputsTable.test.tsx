import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  applyChamberSpiralToOutputs,
  computeChamberOutputs,
  type ChamberSpiralSummary,
} from '@dive/shared';
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

  it('offers the dimension-reference drawing behind a collapsed toggle', () => {
    const { unmount } = render(
      <ChamberOutputsTable outputs={null} constraints={{}} onConstraintChange={() => {}} />,
    );
    // The toggle is there even before outputs exist; the drawing starts hidden.
    expect(screen.getByRole('button', { name: 'Dimension reference' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /annotated chamber drawings/i })).toBeNull();
    unmount();

    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
    );
    const toggle = screen.getByRole('button', { name: 'Dimension reference' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('img', { name: /annotated chamber drawings/i })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('img', { name: /annotated chamber drawings/i })).toBeNull();
  });

  it('renders a row per output with its label and status', () => {
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
    );
    expect(screen.getByText('B Kammer')).toBeInTheDocument();
    expect(screen.getByText('LE (Durchmesser)')).toBeInTheDocument();
    // Outputs with no active relation read "within range"; relation-driven outputs
    // show their relation label. Both counts come from the shared model.
    const withinRange = OUTPUTS.filter((o) => o.status === 'within range').length;
    expect(screen.getAllByText('within range')).toHaveLength(withinRange);
    expect(screen.getByText('= LEB + LEOW')).toBeInTheDocument();
    expect(screen.getByText('= LF1 + LF2')).toBeInTheDocument();
  });

  it('reports a Min edit up as a numeric constraint change', () => {
    const onChange = vi.fn();
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('B Kammer minimum'), { target: { value: '4000' } });
    expect(onChange).toHaveBeenCalledWith('width', 'min', 4000);
  });

  it('lets an identity output (H Kammer) take an Exact override', () => {
    const onChange = vi.fn();
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={onChange} />,
    );
    // The cell exists now (identity rows are editable) and reports up like any other.
    fireEvent.change(screen.getByLabelText('H Kammer exact'), { target: { value: '5000' } });
    expect(onChange).toHaveBeenCalledWith('height', 'exact', 5000);
  });

  it('marks LEOW "no effect" when H Kammer is pinned by an Exact', () => {
    const outputs = computeChamberOutputs({
      x1: 1450,
      x2: 7.85,
      x3: 8,
      constraints: { height: { exact: 4200 } },
    });
    render(
      <ChamberOutputsTable
        outputs={outputs}
        constraints={{ height: { exact: 4200 } }}
        onConstraintChange={() => {}}
      />,
    );
    expect(screen.getByText('no effect')).toBeInTheDocument();
  });

  it('shows no "no effect" tag while LEOW still drives H Kammer', () => {
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
    );
    expect(screen.queryByText('no effect')).not.toBeInTheDocument();
  });

  it('shows the cross-validation error visibly in the confidence pill', () => {
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
    );
    // LEOW's Low pill carries its 38.9% CV error as text, not only as a title.
    expect(screen.getByText(/Low · 38\.9%/)).toBeInTheDocument();
  });

  it('explains the 50 mm grid in the header hint', () => {
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
    );
    expect(screen.getByText(/snap to the 50 mm grid/)).toBeInTheDocument();
  });

  it('flags a non-positive final as not buildable, live', () => {
    // Legal inputs whose own H Kammer fit is negative with relations off.
    const outputs = computeChamberOutputs({ x1: 700, x2: 1.8, x3: 23, relationsMaster: false });
    render(
      <ChamberOutputsTable outputs={outputs} constraints={{}} onConstraintChange={() => {}} />,
    );
    expect(screen.getAllByText('! ≤ 0 mm — not buildable').length).toBeGreaterThan(0);
  });

  it('drops non-positive or absurd constraint input instead of propagating it', () => {
    const onChange = vi.fn();
    render(
      <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('B Kammer minimum'), { target: { value: '-5' } });
    expect(onChange).toHaveBeenLastCalledWith('width', 'min', undefined);
    // Above CHAMBER_DIMENSION_MAX_MM (100 000): dropped like any invalid entry.
    fireEvent.change(screen.getByLabelText('B Kammer maximum'), { target: { value: '200000' } });
    expect(onChange).toHaveBeenLastCalledWith('width', 'max', undefined);
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
    fireEvent.change(screen.getByLabelText('B Kammer minimum'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('width', 'min', undefined);
  });

  describe('semi-spiral casing', () => {
    const SUMMARY: ChamberSpiralSummary = {
      widthMm: 4400,
      worstAreaErrorM2: 0.4309,
      atPhiDeg: 219.4,
      widthBinding: false,
      boxMm: {
        width: 4400,
        length: 4336.64,
        distFromSideChamfer1: 2700,
        distFromEnd: 2200,
        chamferLength1: 1450,
        chamferWidth1: 1400,
        chamferLength2: 1200,
        chamferWidth2: 1150,
      },
    };

    it('shows the derived rows read-only with the "from spiral" status and no value before Generate', () => {
      render(
        <ChamberOutputsTable
          outputs={applyChamberSpiralToOutputs(OUTPUTS, null)}
          constraints={{}}
          onConstraintChange={() => {}}
          spiral={{ on: true, summary: null }}
        />,
      );
      // B1, LT, the four chamfers + the Length row
      expect(screen.getAllByText('from spiral')).toHaveLength(7);
      expect(screen.queryByLabelText('B1 minimum')).toBeNull();
      expect(screen.queryByLabelText('LT exact')).toBeNull();
      expect(screen.getByLabelText('B Kammer minimum')).toBeInTheDocument();
      expect(screen.getByText(/fill in after Generate/)).toBeInTheDocument();
      expect(screen.queryByText('NaN')).toBeNull();
    });

    it('fills the derived rows and the spiral quality after Generate', () => {
      render(
        <ChamberOutputsTable
          outputs={applyChamberSpiralToOutputs(OUTPUTS, SUMMARY.boxMm)}
          constraints={{}}
          onConstraintChange={() => {}}
          spiral={{ on: true, summary: SUMMARY }}
        />,
      );
      const lengthRow = screen.getByText('Length').closest('tr')!;
      expect(lengthRow).toHaveTextContent('4,336.6');
      const ltRow = screen.getByText('LT').closest('tr')!;
      expect(ltRow).toHaveTextContent('2,200');
      expect(screen.getByText(/4400 mm wide/)).toBeInTheDocument();
      expect(screen.getByText(/0\.43 m² at 219°/)).toBeInTheDocument();
    });

    it('has no Length row and no spiral note while the spiral is off', () => {
      render(
        <ChamberOutputsTable outputs={OUTPUTS} constraints={{}} onConstraintChange={() => {}} />,
      );
      expect(screen.queryByText('from spiral')).toBeNull();
      expect(screen.queryByText('Length')).toBeNull();
    });
  });
});
