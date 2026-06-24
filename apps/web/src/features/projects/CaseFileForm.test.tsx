import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaseFileForm } from './CaseFileForm';

const CONTROL_DICT = `FoamFile
{
    class       dictionary;
    object      controlDict;
}
application     simpleFoam;
writeFormat     binary;
endTime         2000;
`;

const FIELD_U = `FoamFile
{
    class       volVectorField;
    object      U;
}
dimensions      [0 1 -1 0 0 0 0];
boundaryField
{
    inlet
    {
        type            flowRateInletVelocity;
    }
    wall
    {
        type            noSlip;
    }
}
`;

describe('CaseFileForm (easy mode)', () => {
  it('renders enum fields as dropdowns with the current value selected', () => {
    render(<CaseFileForm value={CONTROL_DICT} onChange={() => {}} />);
    const writeFormat = screen.getByLabelText('Write format') as HTMLSelectElement;
    expect(writeFormat.value).toBe('binary');
    // The catalog options are offered.
    expect(screen.getByRole('option', { name: 'ascii' })).toBeInTheDocument();
  });

  it('splices a chosen enum value back into the raw file, untouched elsewhere', () => {
    const onChange = vi.fn();
    render(<CaseFileForm value={CONTROL_DICT} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Write format'), { target: { value: 'ascii' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as string;
    expect(next).toContain('writeFormat     ascii;');
    // Everything else is preserved verbatim.
    expect(next).toContain('application     simpleFoam;');
    expect(next).toContain('endTime         2000;');
  });

  it('renders a boundary type dropdown per patch and edits only that patch', () => {
    const onChange = vi.fn();
    render(<CaseFileForm value={FIELD_U} onChange={onChange} />);

    const typeSelects = screen.getAllByLabelText('Boundary type') as HTMLSelectElement[];
    expect(typeSelects).toHaveLength(2); // inlet + wall
    expect(typeSelects[0].value).toBe('flowRateInletVelocity');

    fireEvent.change(typeSelects[0], { target: { value: 'fixedValue' } });
    const next = onChange.mock.calls[0][0] as string;
    expect(next).toContain('type            fixedValue;');
    // The wall patch is untouched.
    expect(next).toContain('type            noSlip;');
  });

  it('commits a text field on blur, not per keystroke', () => {
    const onChange = vi.fn();
    render(<CaseFileForm value={CONTROL_DICT} onChange={onChange} />);

    const endTime = screen.getByLabelText('End time') as HTMLInputElement;
    fireEvent.change(endTime, { target: { value: '500' } });
    expect(onChange).not.toHaveBeenCalled(); // not yet — waits for blur
    fireEvent.blur(endTime);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0] as string).toContain('endTime         500;');
  });

  it('shows an advanced-mode hint for unknown complex blocks', () => {
    const withFunctions = `${CONTROL_DICT}\nfunctions\n{\n    magU { type mag; field U; }\n}\n`;
    render(<CaseFileForm value={withFunctions} onChange={() => {}} />);
    expect(screen.getByText('Edit in Advanced mode')).toBeInTheDocument();
  });
});
