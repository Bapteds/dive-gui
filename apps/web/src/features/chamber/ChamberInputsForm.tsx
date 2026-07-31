import type { FormEventHandler } from 'react';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { CHAMBER_INPUT_RANGES, type ChamberVariant } from '@dive/shared';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { ChamberFormValues } from './chamberForm';

/**
 * ChamberInputsForm - the three empirical inputs (X1/X2/X3), the cylinder design
 * variant, the box length (blank = 2 x width), and - for the hollow variant - the
 * hollow cup's length and wall thickness. Presentational: the parent owns the
 * react-hook-form instance (so the outputs table can live-compute from the same
 * values) and passes register + errors + the current variant + the auto length in.
 */

const r = CHAMBER_INPUT_RANGES;

/** Map a blank field to undefined (so an optional number stays optional). */
const numOrUndef = (v: unknown) => (v === '' || v == null ? undefined : Number(v));

export function ChamberInputsForm({
  register,
  errors,
  onSubmit,
  isBuilding,
  variant,
  autoLengthMm,
}: {
  register: UseFormRegister<ChamberFormValues>;
  errors: FieldErrors<ChamberFormValues>;
  onSubmit: FormEventHandler<HTMLFormElement>;
  isBuilding: boolean;
  variant: ChamberVariant;
  autoLengthMm: number | null;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-5 rounded-md border border-border bg-surface p-5 shadow-sm"
      noValidate
    >
      <div>
        <h2 className="text-lg font-semibold text-text">Inputs</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Three empirical inputs drive the twelve geometry parameters. Lengths are in
          millimetres.
        </p>
      </div>

      <Field label="Cylinder design">
        <NativeSelect {...register('variant')}>
          <option value="stepped">Stepped — three solid cylinders</option>
          <option value="hollow">Hollow — open-top cup + central dome</option>
        </NativeSelect>
      </Field>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('interdependency')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Interdependency refinement</span>
          <span className="mt-0.5 block text-text-secondary">
            Sharpen linked parameters (Width ↔ Chamfer-1 side distance, Height ↔ Last cylinder
            height) from a known Exact value. Uncheck to depend on X1–X3 only.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="X1" error={errors.x1?.message} helperText={`Valid ${r.x1.min}–${r.x1.max}`}>
          <Input type="number" step="any" {...register('x1', { valueAsNumber: true })} />
        </Field>
        <Field label="X2" error={errors.x2?.message} helperText={`Valid ${r.x2.min}–${r.x2.max}`}>
          <Input type="number" step="any" {...register('x2', { valueAsNumber: true })} />
        </Field>
        <Field label="X3" error={errors.x3?.message} helperText={`Valid ${r.x3.min}–${r.x3.max}`}>
          <Input type="number" step="any" {...register('x3', { valueAsNumber: true })} />
        </Field>
        <Field
          label="Length (mm)"
          error={errors.lengthOverride?.message}
          helperText={
            autoLengthMm != null
              ? `Blank = 2 × width ≈ ${Math.round(autoLengthMm)} mm`
              : 'Blank = 2 × width'
          }
        >
          <Input
            type="number"
            step="any"
            placeholder="auto"
            {...register('lengthOverride', { setValueAs: numOrUndef })}
          />
        </Field>
        <Field
          label="Foot angle (°)"
          error={errors.footAngleDeg?.message}
          helperText="Gusset needs ≈37–143° (not ≈90°); nearer 0/90/180 the build is refused"
        >
          <Input
            type="number"
            step="any"
            {...register('footAngleDeg', { valueAsNumber: true })}
          />
        </Field>
      </div>

      {variant === 'hollow' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Hollow length (mm)"
            error={errors.hollowLength?.message}
            helperText="Height of the open-top cup"
          >
            <Input
              type="number"
              step="any"
              {...register('hollowLength', { setValueAs: numOrUndef })}
            />
          </Field>
          <Field
            label="Wall thickness (mm)"
            error={errors.wallThickness?.message}
            helperText="Cup walls + bottom (default 50)"
          >
            <Input
              type="number"
              step="any"
              {...register('wallThickness', { setValueAs: numOrUndef })}
            />
          </Field>
        </div>
      )}

      <Button type="submit" loading={isBuilding} className="w-full sm:w-auto sm:self-start">
        Generate chamber
      </Button>
    </form>
  );
}

export default ChamberInputsForm;
