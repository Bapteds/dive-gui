import { Suspense, lazy, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Send } from 'lucide-react';
import {
  CHAMBER_CENTRAL_DIAMETER_OVER_X1,
  CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER,
  CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT,
  CHAMBER_D_FIRST_OVER_LAST,
  CHAMBER_D_MIDDLE_OVER_LAST,
  computeChamberOutputs,
} from '@dive/shared';
import type { ChamberConstraint, ChamberOutput, ChamberOutputKey } from '@/lib/api/types';
import { ApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { ChamberInputsForm, type ChamberAutoDims } from '@/features/chamber/ChamberInputsForm';
import {
  CHAMBER_FORM_DEFAULTS,
  chamberFormSchema,
  chamberInputToFormValues,
  type ChamberFormValues,
} from '@/features/chamber/chamberForm';
import { ChamberSavesMenu } from '@/features/chamber/ChamberSavesMenu';
import { ChamberOutputsTable } from '@/features/chamber/ChamberOutputsTable';
import { ChamberBuildWarnings } from '@/features/chamber/ChamberBuildWarnings';
import { ChamberExportButtons } from '@/features/chamber/ChamberExportButtons';
import { SendToMeshingDialog } from '@/features/chamber/SendToMeshingDialog';
import { Button } from '@/components/ui/button';
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
    setValue,
    reset,
    formState: { errors, isValid },
  } = useForm<ChamberFormValues>({
    resolver: zodResolver(chamberFormSchema),
    defaultValues: CHAMBER_FORM_DEFAULTS,
    mode: 'onChange',
  });

  const [constraints, setConstraints] = useState<Partial<Record<ChamberOutputKey, ChamberConstraint>>>(
    {},
  );
  const [hash, setHash] = useState<string | null>(null);
  // Geometry clamp warnings from the LAST build (kept in step with `hash`).
  const [buildWarnings, setBuildWarnings] = useState<string[]>([]);
  const [sendOpen, setSendOpen] = useState(false);
  const build = useBuildChamber();

  const values = watch();
  const relationsKey = JSON.stringify(values.relations);
  const outputs = useMemo<ChamberOutput[] | null>(() => {
    const { x1, x2, x3, relationsMaster, relations } = values;
    if (![x1, x2, x3].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return null;
    }
    return computeChamberOutputs({ x1, x2, x3, constraints, relationsMaster, relations });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.x1, values.x2, values.x3, values.relationsMaster, relationsKey, constraints]);

  // Auto length shown on the (blank) length field = 2 x the final width (mm).
  const widthFinal = outputs?.find((o) => o.key === 'width')?.final ?? null;
  const autoLengthMm = widthFinal != null ? 2 * widthFinal : null;

  // Auto (empirical) placeholders for the five manual dimension overrides — the same
  // fixed ratios the API falls back to, shown as "auto ≈ N mm" hints on blank fields.
  const dLastFinal = outputs?.find((o) => o.key === 'dLast')?.final ?? null;
  const x1Value = typeof values.x1 === 'number' && Number.isFinite(values.x1) ? values.x1 : null;
  const centralDiameterAuto =
    x1Value != null ? CHAMBER_CENTRAL_DIAMETER_OVER_X1 * x1Value : null;
  const centralHeightAuto =
    centralDiameterAuto != null ? CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER * centralDiameterAuto : null;
  const autoDims: ChamberAutoDims = {
    dFirst: dLastFinal != null ? CHAMBER_D_FIRST_OVER_LAST * dLastFinal : null,
    dMiddle: dLastFinal != null ? CHAMBER_D_MIDDLE_OVER_LAST * dLastFinal : null,
    centralDiameter: centralDiameterAuto,
    centralHeight: centralHeightAuto,
    domeHeight:
      centralHeightAuto != null ? CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT * centralHeightAuto : null,
  };

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

  // The current form as a build body for the saved-builds Save button (null
  // while the form is invalid, which disables saving an unbuildable state).
  const saveSnapshot = isValid ? { ...values, constraints } : null;

  const onGenerate = handleSubmit((v) => {
    build.mutate(
      { ...v, constraints },
      {
        onSuccess: (res) => {
          setHash(res.hash);
          setBuildWarnings(res.warnings ?? []);
          if (res.warnings?.length) {
            toast.warning('Chamber generated with warnings — see the notes below the preview.');
          } else {
            toast.success('Chamber generated.');
          }
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
        action={
          <ChamberSavesMenu
            snapshot={saveSnapshot}
            onLoad={(save) => {
              reset(chamberInputToFormValues(save.snapshot));
              setConstraints(save.snapshot.constraints ?? {});
            }}
          />
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(22rem,1fr)_2.5fr]">
        <div className="flex flex-col gap-4">
          <ChamberInputsForm
            register={register}
            errors={errors}
            onSubmit={onGenerate}
            isBuilding={build.isPending}
            variant={values.variant}
            autoLengthMm={autoLengthMm}
            autoDims={autoDims}
            relationsMaster={values.relationsMaster}
            relations={values.relations}
            onRelationChange={(key, on) =>
              setValue(`relations.${key}` as `relations.${string}`, on, { shouldDirty: true })
            }
          />
          <div className="rounded-md border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-text">Export</h2>
            <p className="mb-4 mt-1 text-sm text-text-secondary">
              Download the built chamber for meshing or CAD.
            </p>
            <ChamberExportButtons hash={hash} />
            <div className="mt-4 border-t border-border pt-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!hash}
                onClick={() => setSendOpen(true)}
              >
                <Send className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Send to Meshing
              </Button>
            </div>
            {hash && (
              <SendToMeshingDialog hash={hash} open={sendOpen} onOpenChange={setSendOpen} />
            )}
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

      {/* The page is full-width (AppShell opts /chamber out of the centered
          container) so the viewer can stretch; the Parameters table would be
          unreadably wide at that size, so it keeps the classic content width. */}
      <div className="flex w-full max-w-content flex-col gap-6">
        <ChamberBuildWarnings warnings={buildWarnings} />

        <ChamberOutputsTable
          outputs={outputs}
          constraints={constraints}
          onConstraintChange={onConstraintChange}
        />
      </div>
    </div>
  );
}

export default ChamberPage;
