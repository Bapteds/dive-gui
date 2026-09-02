import type { FormEventHandler } from 'react';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { ChevronDown } from 'lucide-react';
import { CHAMBER_INPUT_RANGES, CHAMBER_RELATIONS, type ChamberVariant } from '@dive/shared';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChamberAutoDims, ChamberFormValues } from './chamberForm';

export type { ChamberAutoDims } from './chamberForm';

/**
 * ChamberInputsForm - the three empirical inputs (X1/X2/X3), the cylinder design
 * variant, the box length (blank = 2 x width), and - for the hollow variant - the
 * hollow cup's length and wall thickness, plus X4 steering the generator autos
 * (Gen Dim v3). Presentational: the parent owns the react-hook-form instance (so
 * the outputs table can live-compute from the same values) and passes register +
 * errors + the current variant + the auto length in.
 */

const r = CHAMBER_INPUT_RANGES;

/** Map a blank field to undefined (so an optional number stays optional). */
const numOrUndef = (v: unknown) => (v === '' || v == null ? undefined : Number(v));

/** Helper text for an override field: "Blank = auto ≈ N mm" (or a bare fallback). */
function autoHint(mm: number | null): string {
  return mm != null ? `Blank = auto ≈ ${Math.round(mm)} mm` : 'Blank = auto';
}

export function ChamberInputsForm({
  register,
  errors,
  onSubmit,
  isBuilding,
  variant,
  autoLengthMm,
  autoDims,
  relationsMaster,
  relations,
  onRelationChange,
}: {
  register: UseFormRegister<ChamberFormValues>;
  errors: FieldErrors<ChamberFormValues>;
  onSubmit: FormEventHandler<HTMLFormElement>;
  isBuilding: boolean;
  variant: ChamberVariant;
  autoLengthMm: number | null;
  /** Auto (empirical) placeholders for the five manual dimension overrides. */
  autoDims: ChamberAutoDims;
  /** Current master switch state (governs whether individual relations apply). */
  relationsMaster: boolean;
  /** Current per-relation on/off, keyed by the driven output. */
  relations: Record<string, boolean>;
  /** Toggle one relation on/off. */
  onRelationChange: (key: string, on: boolean) => void;
}) {
  const relOn = (key: string, fallback: boolean) => relations[key] ?? fallback;
  const activeCount = CHAMBER_RELATIONS.filter((rel) => relOn(rel.key, rel.defaultOn)).length;
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
          <option value="stepped">Closed generator — three solid cylinders</option>
          <option value="hollow">With cone — open-top cone</option>
        </NativeSelect>
      </Field>

      <div className="rounded-md border border-border bg-bg p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            {...register('relationsMaster')}
            className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
          />
          <span className="text-sm">
            <span className="font-medium text-text">Structural relations</span>
            <span className="mt-0.5 block text-text-secondary">
              Link parameters to each other (e.g. LT = LF1 + LF2, LEB = 2 × HLE). Uncheck to
              make every parameter depend on Runner Ø / Head / Q_max only.
            </span>
          </span>
        </label>

        <div className="mt-3 pl-7">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!relationsMaster}>
              <button
                type="button"
                className="inline-flex w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 py-1.5 text-sm text-text transition-colors duration-fast ease-out hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>
                  Configure relations{' '}
                  <span className="text-text-secondary">
                    ({relationsMaster ? activeCount : 0}/{CHAMBER_RELATIONS.length} on)
                  </span>
                </span>
                <ChevronDown className="size-4 text-text-secondary" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[20rem]">
              <DropdownMenuLabel>Toggle individual relations</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {CHAMBER_RELATIONS.map((rel) => (
                <DropdownMenuCheckboxItem
                  key={rel.key}
                  checked={relOn(rel.key, rel.defaultOn)}
                  onCheckedChange={(c) => onRelationChange(rel.key, c === true)}
                  onSelect={(e) => e.preventDefault()}
                  className="items-start"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm text-text">
                      <span className="font-medium">{rel.label}</span>{' '}
                      <span className="text-text-secondary">{rel.relationLabel}</span>
                    </span>
                    <span className="text-xs text-text-secondary">{rel.description}</span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('guideVanes')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Guide vanes</span>
          <span className="mt-0.5 block text-text-secondary">
            Replace the middle cylinder with a ring of guide vanes (both designs).
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('chamferEnabled')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Chamfer</span>
          <span className="mt-0.5 block text-text-secondary">
            Cut the two corners at the inlet end. Turn off for a square-ended box - the rest of
            the geometry (cylinders, feet, outputs table) is unaffected.
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
        <input
          type="checkbox"
          {...register('feetEnabled')}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        />
        <span className="text-sm">
          <span className="font-medium text-text">Feet</span>
          <span className="mt-0.5 block text-text-secondary">
            Cut the four torque-foot voids (legs and their planks). Turn off to keep the box
            solid where the feet would be - the cylinders and outputs table are unaffected.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Runner Ø (mm)"
          error={errors.x1?.message}
          helperText={`Valid ${r.x1.min}–${r.x1.max}`}
        >
          <Input type="number" step="any" {...register('x1', { valueAsNumber: true })} />
        </Field>
        <Field
          label="Head (m)"
          error={errors.x2?.message}
          helperText={`Valid ${r.x2.min}–${r.x2.max}`}
        >
          <Input type="number" step="any" {...register('x2', { valueAsNumber: true })} />
        </Field>
        <Field
          label="Q_max (m³/s)"
          error={errors.x3?.message}
          helperText={`Valid ${r.x3.min}–${r.x3.max}`}
        >
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
        <Field
          label="Part scale (×)"
          error={errors.partScale?.message}
          helperText="Scales all cylinders, feet & vanes together; box & axis stay fixed. Stepped: overgrowing the box is refused; cone: scaled down to fit"
        >
          <Input
            type="number"
            step="0.05"
            min="0"
            {...register('partScale', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Vane angle (°)"
          error={errors.vaneAngleDeg?.message}
          helperText="Guide-vane builds only: open angle 45–55° (50 = as-designed); each blade pitches about its spindle"
        >
          <Input
            type="number"
            step="0.5"
            min="45"
            max="55"
            {...register('vaneAngleDeg', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Outlet ratio"
          error={errors.outletRatio?.message}
          helperText="Guide-vane builds only: inner/outer diameter ratio 0.35–0.50 (0.45 = default)"
        >
          <Input
            type="number"
            step="0.01"
            min="0.35"
            max="0.5"
            {...register('outletRatio', { valueAsNumber: true })}
          />
        </Field>
        <Field
          label="Runner case Ø (mm)"
          error={errors.dFirst?.message}
          helperText={autoHint(autoDims.dFirst)}
        >
          <Input
            type="number"
            step="any"
            placeholder="auto"
            {...register('dFirst', { setValueAs: numOrUndef })}
          />
        </Field>
        <Field
          label="Guide vanes Ø (mm)"
          error={errors.dMiddle?.message}
          helperText={`${autoHint(autoDims.dMiddle)} · sets the vane ring in guide-vane builds`}
        >
          <Input
            type="number"
            step="any"
            placeholder="auto"
            {...register('dMiddle', { setValueAs: numOrUndef })}
          />
        </Field>
      </div>

      {variant === 'hollow' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Cone length (mm)"
            error={errors.hollowLength?.message}
            helperText="Height of the open-top cone"
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
            helperText="Cone walls + bottom (default 50)"
          >
            <Input
              type="number"
              step="any"
              {...register('wallThickness', { setValueAs: numOrUndef })}
            />
          </Field>
          <Field
            label="Power (kW)"
            error={errors.x4?.message}
            helperText={
              autoDims.x4 != null
                ? `Blank = auto ≈ ${Math.round(autoDims.x4)} kW (0.9 · 9.81 · Head · Q_max)`
                : 'Blank = auto (0.9 · 9.81 · Head · Q_max)'
            }
          >
            <Input
              type="number"
              step="any"
              placeholder="auto"
              {...register('x4', { setValueAs: numOrUndef })}
            />
          </Field>
          <Field
            label="Generator Ø (mm)"
            error={errors.centralDiameter?.message}
            helperText={autoHint(autoDims.centralDiameter)}
          >
            <Input
              type="number"
              step="any"
              placeholder="auto"
              {...register('centralDiameter', { setValueAs: numOrUndef })}
            />
          </Field>
          <Field
            label="Generator height (mm)"
            error={errors.centralHeight?.message}
            helperText={autoHint(autoDims.centralHeight)}
          >
            <Input
              type="number"
              step="any"
              placeholder="auto"
              {...register('centralHeight', { setValueAs: numOrUndef })}
            />
          </Field>
          <Field
            label="Dome height (mm)"
            error={errors.domeHeight?.message}
            helperText={autoHint(autoDims.domeHeight)}
          >
            <Input
              type="number"
              step="any"
              placeholder="auto"
              {...register('domeHeight', { setValueAs: numOrUndef })}
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
