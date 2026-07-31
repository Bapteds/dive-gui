import { Suspense, lazy, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { computeChamberOutputs } from '@dive/shared';
import type { ChamberConstraint, ChamberOutput, ChamberOutputKey } from '@/lib/api/types';
import { ApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { ChamberInputsForm } from '@/features/chamber/ChamberInputsForm';
import {
  CHAMBER_FORM_DEFAULTS,
  chamberFormSchema,
  type ChamberFormValues,
} from '@/features/chamber/chamberForm';
import { ChamberOutputsTable } from '@/features/chamber/ChamberOutputsTable';
import { ChamberExportButtons } from '@/features/chamber/ChamberExportButtons';
import { useBuildChamber } from '@/features/chamber/useChamber';

// The 3D viewer pulls in three.js; lazy-load it so the initial bundle stays lean
// (the Visualize tab does the same).
const ChamberViewer = lazy(() =>
  import('@/features/chamber/ChamberViewer').then((m) => ({ default: m.ChamberViewer })),
);

/**
 * ChamberPage - the standalone Chamber Creation tool. Three empirical inputs +
 * a direct length drive twelve geometry parameters (computed live via the shared
 * model, with optional Min / Max / Exact overrides); Generate builds the CadQuery
 * solid, previews it in the reused 3D patch viewer, and enables STL / STEP /
 * OpenFOAM triSurface downloads.
 */
export function ChamberPage() {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ChamberFormValues>({
    resolver: zodResolver(chamberFormSchema),
    defaultValues: CHAMBER_FORM_DEFAULTS,
    mode: 'onChange',
  });

  const [constraints, setConstraints] = useState<Partial<Record<ChamberOutputKey, ChamberConstraint>>>(
    {},
  );
  const [hash, setHash] = useState<string | null>(null);
  const build = useBuildChamber();

  const values = watch();
  const outputs = useMemo<ChamberOutput[] | null>(() => {
    const { x1, x2, x3, interdependency } = values;
    if (![x1, x2, x3].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return null;
    }
    return computeChamberOutputs({ x1, x2, x3, constraints, interdependency });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.x1, values.x2, values.x3, values.interdependency, constraints]);

  // Auto length shown on the (blank) length field = 2 x the final width (mm).
  const widthFinal = outputs?.find((o) => o.key === 'width')?.final ?? null;
  const autoLengthMm = widthFinal != null ? 2 * widthFinal : null;

  const onConstraintChange = (
    key: ChamberOutputKey,
    field: keyof ChamberConstraint,
    value: number | undefined,
  ) => {
    setConstraints((prev) => {
      const next = { ...prev };
      const current: ChamberConstraint = { ...(next[key] ?? {}) };
      if (value === undefined) {
        delete current[field];
      } else {
        current[field] = value;
      }
      if (Object.keys(current).length === 0) {
        delete next[key];
      } else {
        next[key] = current;
      }
      return next;
    });
  };

  const onGenerate = handleSubmit((v) => {
    build.mutate(
      { ...v, constraints },
      {
        onSuccess: (res) => {
          setHash(res.hash);
          toast.success('Chamber generated.');
        },
        onError: (err) => {
          toast.error(err instanceof ApiError ? err.message : 'Could not generate the chamber.');
        },
      },
    );
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Chamber Creation"
        subtitle="Generate a turbine chamber from three empirical inputs, preview it, and export it for OpenFOAM."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <div className="flex flex-col gap-4">
          <ChamberInputsForm
            register={register}
            errors={errors}
            onSubmit={onGenerate}
            isBuilding={build.isPending}
            variant={values.variant}
            autoLengthMm={autoLengthMm}
          />
          <div className="rounded-md border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-text">Export</h2>
            <p className="mb-4 mt-1 text-sm text-text-secondary">
              Download the built chamber for meshing or CAD.
            </p>
            <ChamberExportButtons hash={hash} />
          </div>
        </div>

        <div className="flex min-h-[60vh] flex-col">
          <Suspense
            fallback={
              <div
                className="flex flex-1 items-center justify-center rounded-md border border-border bg-surface shadow-sm"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
              </div>
            }
          >
            <ChamberViewer hash={hash} />
          </Suspense>
        </div>
      </div>

      <ChamberOutputsTable
        outputs={outputs}
        constraints={constraints}
        onConstraintChange={onConstraintChange}
      />
    </div>
  );
}

export default ChamberPage;
