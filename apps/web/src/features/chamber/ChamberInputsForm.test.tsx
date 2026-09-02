import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CHAMBER_RELATIONS, type ChamberVariant } from '@dive/shared';
import { ChamberInputsForm, type ChamberAutoDims } from './ChamberInputsForm';
import { CHAMBER_FORM_DEFAULTS, chamberFormSchema, type ChamberFormValues } from './chamberForm';

/**
 * ChamberInputsForm tests. The component is presentational (the parent owns the
 * react-hook-form instance), so a harness wires it exactly like ChamberPage does
 * (useForm + zodResolver) and the tests drive it as a user would: the hollow
 * section follows the variant, blank overrides submit as undefined (auto), the
 * auto hints render, and a hollow submit without a cone length surfaces the
 * validation error instead of submitting.
 */

const AUTO_DIMS: ChamberAutoDims = {
  dFirst: 2777.6,
  dMiddle: 1937.1,
  x4: 618.03,
  centralDiameter: 1087.5,
  centralHeight: 1446.4,
  domeHeight: 289.3,
};

function Harness({
  onValid,
  variant,
  defaults,
  relationsMaster = true,
}: {
  onValid: (values: ChamberFormValues) => void;
  variant?: ChamberVariant;
  defaults?: Partial<ChamberFormValues>;
  relationsMaster?: boolean;
}) {
  const values: ChamberFormValues = { ...CHAMBER_FORM_DEFAULTS, ...defaults };
  const { register, handleSubmit, formState } = useForm<ChamberFormValues>({
    resolver: zodResolver(chamberFormSchema),
    defaultValues: values,
  });
  return (
    <ChamberInputsForm
      register={register}
      errors={formState.errors}
      onSubmit={handleSubmit(onValid)}
      isBuilding={false}
      variant={variant ?? values.variant}
      simplifyGenerator={values.simplifyGenerator}
      autoLengthMm={8889}
      autoDims={AUTO_DIMS}
      relationsMaster={relationsMaster}
      relations={values.relations}
      onRelationChange={() => {}}
    />
  );
}

describe('ChamberInputsForm', () => {
  it('shows the hollow-only fields for the hollow variant and hides them for stepped', () => {
    const { rerender } = render(<Harness onValid={() => {}} />);
    expect(screen.queryByLabelText('Cone length (mm)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Generator Ø (mm)')).not.toBeInTheDocument();

    rerender(
      <Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />,
    );
    expect(screen.getByLabelText('Cone length (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Wall thickness (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Generator Ø (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Generator height (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Dome height (mm)')).toBeInTheDocument();
  });

  it('renders the auto placeholders as rounded mm hints', () => {
    render(<Harness onValid={() => {}} />);
    expect(screen.getByText('Blank = auto ≈ 2778 mm')).toBeInTheDocument();
    expect(screen.getByText(/Blank = auto ≈ 1937 mm/)).toBeInTheDocument();
    expect(screen.getByText('Blank = 2 × width ≈ 8889 mm')).toBeInTheDocument();
  });

  it('submits the defaults with every blank override as undefined (auto)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    const values = onValid.mock.calls[0][0] as ChamberFormValues;
    expect(values.x1).toBe(1450);
    expect(values.variant).toBe('stepped');
    expect(values.lengthOverride).toBeUndefined();
    expect(values.dFirst).toBeUndefined();
    expect(values.dMiddle).toBeUndefined();
  });

  it('submits a typed override as a number and maps clearing it back to undefined', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    const dFirst = screen.getByLabelText('Runner case Ø (mm)');

    fireEvent.change(dFirst, { target: { value: '2800' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).dFirst).toBe(2800);

    fireEvent.change(dFirst, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(2));
    expect((onValid.mock.calls[1][0] as ChamberFormValues).dFirst).toBeUndefined();
  });

  it('blocks a hollow submit without a cone length and shows the error', async () => {
    const onValid = vi.fn();
    render(
      <Harness
        onValid={onValid}
        variant="hollow"
        defaults={{ variant: 'hollow', hollowLength: undefined }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    expect(
      await screen.findByText('A cone length is required for this variant.'),
    ).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('blocks an out-of-range Runner Ø (X1) and shows its range error', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.change(screen.getByLabelText('Runner Ø (mm)'), { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onValid).not.toHaveBeenCalled();
  });

  it('shows the active relation count and disables Configure when the master is off', () => {
    const { rerender } = render(<Harness onValid={() => {}} />);
    const defaultOn = CHAMBER_RELATIONS.filter((rel) => rel.defaultOn).length;
    expect(
      screen.getByRole('button', { name: new RegExp(`\\(${defaultOn}/${CHAMBER_RELATIONS.length} on\\)`) }),
    ).toBeEnabled();

    rerender(<Harness onValid={() => {}} relationsMaster={false} />);
    expect(
      screen.getByRole('button', { name: new RegExp(`\\(0/${CHAMBER_RELATIONS.length} on\\)`) }),
    ).toBeDisabled();
  });

  it('shows the Power (X4) field with its formula hint in the hollow variant only', () => {
    const { rerender } = render(<Harness onValid={() => {}} />);
    expect(screen.queryByLabelText('Power (kW)')).not.toBeInTheDocument();

    rerender(<Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />);
    expect(screen.getByLabelText('Power (kW)')).toBeInTheDocument();
    expect(
      screen.getByText('Blank = auto ≈ 618 kW (0.9 · 9.81 · Head · Q_max)'),
    ).toBeInTheDocument();
  });

  it('Simplify generator toggles in the hollow section and hides the height/dome fields', () => {
    const { rerender } = render(<Harness onValid={() => {}} />);
    // Stepped: no Simplify generator checkbox at all.
    expect(screen.queryByLabelText(/Simplify generator/)).not.toBeInTheDocument();

    rerender(<Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />);
    expect(screen.getByLabelText(/Simplify generator/)).toBeInTheDocument();
    expect(screen.getByLabelText('Generator height (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Dome height (mm)')).toBeInTheDocument();

    // Flag on: the two meaningless fields disappear; Ø and Power stay.
    rerender(
      <Harness
        onValid={() => {}}
        variant="hollow"
        defaults={{ variant: 'hollow', simplifyGenerator: true }}
      />,
    );
    expect(screen.queryByLabelText('Generator height (mm)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dome height (mm)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Generator Ø (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('Power (kW)')).toBeInTheDocument();
  });

  it('submits the Simplify generator flag with the form values', async () => {
    // A fresh mount (not a rerender): useForm reads defaultValues once.
    const onValid = vi.fn();
    render(
      <Harness
        onValid={onValid}
        variant="hollow"
        defaults={{ variant: 'hollow', simplifyGenerator: true }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).simplifyGenerator).toBe(true);
  });

  it('submits a typed Power (x4) as a number and a blank one as undefined (auto)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} variant="hollow" defaults={{ variant: 'hollow' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).x4).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Power (kW)'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(2));
    expect((onValid.mock.calls[1][0] as ChamberFormValues).x4).toBe(2000);
  });
});
