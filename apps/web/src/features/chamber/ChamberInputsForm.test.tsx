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
  generatorToTop: 2700,
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
  const { register, handleSubmit, formState, setValue, watch } = useForm<ChamberFormValues>({
    resolver: zodResolver(chamberFormSchema),
    defaultValues: values,
  });
  const semiSpiral = watch('semiSpiral');
  return (
    <ChamberInputsForm
      register={register}
      errors={formState.errors}
      onSubmit={handleSubmit(onValid)}
      isBuilding={false}
      variant={variant ?? values.variant}
      simplifyGenerator={values.simplifyGenerator}
      coneChamferEnabled={values.coneChamferEnabled}
      semiSpiral={semiSpiral}
      onSemiSpiralChange={(on) => {
        // As ChamberPage: the spiral needs Feet off, and its L2/L4 are the chamfers.
        if (on) {
          setValue('feetEnabled', false);
          setValue('chamferEnabled', false);
        }
      }}
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
    expect(screen.queryByLabelText('Dome height (mm)')).not.toBeInTheDocument();

    rerender(<Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />);
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
      await screen.findByText('Enter a cone length: the With cone design needs one.'),
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
      screen.getByRole('button', {
        name: new RegExp(`\\(${defaultOn}/${CHAMBER_RELATIONS.length} on\\)`),
      }),
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

  it('offers a generator height in the Closed generator design (blank = through the top)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    expect(screen.getByLabelText('Generator height (mm)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Blank = through the chamber top ≈ 2700 mm (min ≈ 1446 + dome 289 = 1736 mm); a value closes it below',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).centralHeight).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Generator height (mm)'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(2));
    expect((onValid.mock.calls[1][0] as ChamberFormValues).centralHeight).toBe(1500);
  });

  it('Simplify generator toggles in the hollow section: keeps the height, hides the dome', () => {
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
    expect(screen.getByLabelText('Generator height (mm)')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Blank = through the chamber top ≈ 2700 mm \(min ≈ 1446 \+ dome 289 = 1736 mm\)/,
      ),
    ).toBeInTheDocument();
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

  it.each(['stepped', 'hollow'] as const)(
    'offers Cone chamfer in the %s design, with its size field only when ticked',
    (variant) => {
      const { unmount } = render(
        <Harness onValid={() => {}} variant={variant} defaults={{ variant }} />,
      );
      const box = screen.getByRole('checkbox', { name: /Cone chamfer/ });
      expect(box).not.toBeChecked();
      expect(screen.queryByLabelText('Cone chamfer size (mm)')).not.toBeInTheDocument();
      unmount();

      render(
        <Harness
          onValid={() => {}}
          variant={variant}
          defaults={{ variant, coneChamferEnabled: true }}
        />,
      );
      expect(screen.getByLabelText('Cone chamfer size (mm)')).toBeInTheDocument();
      expect(screen.getByText('Blank = 50 mm')).toBeInTheDocument();
    },
  );

  it.each(['stepped', 'hollow'] as const)(
    'submits the cone chamfer flag and its default 50 mm size in the %s design',
    async (variant) => {
      const onValid = vi.fn();
      render(
        <Harness
          onValid={onValid}
          variant={variant}
          defaults={{ variant, coneChamferEnabled: true }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
      await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
      const submitted = onValid.mock.calls[0][0] as ChamberFormValues;
      expect(submitted.coneChamferEnabled).toBe(true);
      expect(submitted.coneChamferSize).toBe(50);
    },
  );

  it.each(['stepped', 'hollow'] as const)(
    'offers a Guide vane count number field (8 to 32, step 1) in the %s design',
    (variant) => {
      render(<Harness onValid={() => {}} variant={variant} defaults={{ variant }} />);
      const input = screen.getByLabelText('Guide vane count') as HTMLInputElement;
      expect(input.tagName).toBe('INPUT');
      expect(input.type).toBe('number');
      expect(input.min).toBe('8');
      expect(input.max).toBe('32');
      expect(input.step).toBe('1');
      expect(input.value).toBe('16');
      expect(screen.getByText('Guide-vane builds only')).toBeInTheDocument();
    },
  );

  it('submits the typed guide vane count as a number', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.change(screen.getByLabelText('Guide vane count'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).vaneCount).toBe(24);
  });

  it.each(['7', '33', '12.5', ''])('blocks a guide vane count of "%s" with the form message', async (value) => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.change(screen.getByLabelText('Guide vane count'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    expect(await screen.findByText('Enter a whole number from 8 to 32')).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
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

  describe('semi-spiral casing', () => {
    it('offers the checkbox in both designs', () => {
      const { rerender } = render(<Harness onValid={() => {}} />);
      expect(screen.getByLabelText(/Semi-spiral casing/)).toBeInTheDocument();
      rerender(<Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />);
      expect(screen.getByLabelText(/Semi-spiral casing/)).toBeInTheDocument();
    });

    it('unchecks and disables Feet and Chamfer, hides Length and shows the casing flow velocity', async () => {
      render(<Harness onValid={() => {}} />);
      expect(screen.getByLabelText('Length (mm)')).toBeInTheDocument();
      expect(screen.queryByLabelText('Casing flow velocity (m/s)')).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText(/Semi-spiral casing/));
      await waitFor(() =>
        expect(screen.getByLabelText('Casing flow velocity (m/s)')).toBeInTheDocument(),
      );
      const feet = screen.getByLabelText(/^Feet/) as HTMLInputElement;
      const chamfer = screen.getByLabelText(/^Chamfer/) as HTMLInputElement;
      expect(feet).toBeDisabled();
      expect(feet.checked).toBe(false);
      expect(chamfer).toBeDisabled();
      expect(chamfer.checked).toBe(false);
      expect(screen.queryByLabelText('Length (mm)')).not.toBeInTheDocument();
      expect(screen.getByText(/Off while Semi-spiral casing is on/)).toBeInTheDocument();
    });

    it('submits the flag, Feet off and the velocity', async () => {
      const onValid = vi.fn();
      render(<Harness onValid={onValid} />);
      fireEvent.click(screen.getByLabelText(/Semi-spiral casing/));
      const velocity = await screen.findByLabelText('Casing flow velocity (m/s)');
      fireEvent.change(velocity, { target: { value: '0.8' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
      await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
      const submitted = onValid.mock.calls[0][0] as ChamberFormValues;
      expect(submitted.semiSpiral).toBe(true);
      expect(submitted.feetEnabled).toBe(false);
      expect(submitted.spiralFlowVelocity).toBe(0.8);
    });
  });
});
