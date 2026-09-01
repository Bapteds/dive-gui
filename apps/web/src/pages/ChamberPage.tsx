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
import type { ChamberConstraint, ChamberInput, ChamberOutput, ChamberOutputKey } from '@/lib/api/types';
import { ApiError } from '@/lib/api/client';
import { buildChamber as buildChamberRequest, type ChamberExportKind } from '@/lib/api/chamber';
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
  // Whether the LAST build gets the STEP menu with "Change rotational
  // direction" (kept in step with `hash`): a guide-vane build whose STEP is
  // not already KNOWN to be the vane-less fallback. Vane builds defer the STEP
  // export, so stepHasVanes is usually null until the first STEP download.
  const [offerMirror, setOfferMirror] = useState(false);
  // The exact body of the LAST successful build: powers the "inputs changed
  // since this build" note and the silent post-download refresh (a re-POST of
  // this body is a guaranteed cache hit on the same hash).
  const [lastBuildInput, setLastBuildInput] = useState<ChamberInput | null>(null);
  // Geometry clamp warnings from the LAST build (kept in step with `hash`).
  const [buildWarnings, setBuildWarnings] = useState<string[]>([]);
  // Why the LAST Generate produced nothing (refused build or invalid inputs).
  // Shown in the notices panel before the Parameters table AND as a toast, so
  // every error/warning surfaces in both places.
  const [buildErrors, setBuildErrors] = useState<string[]>([]);
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

  // Field labels for the invalid-submit summary, mirroring the Inputs form.
  const FIELD_LABELS: Partial<Record<keyof ChamberFormValues, string>> = {
    x1: 'X1',
    x2: 'X2',
    x3: 'X3',
    lengthOverride: 'Length',
    footAngleDeg: 'Foot angle',
    partScale: 'Part scale',
    vaneAngleDeg: 'Vane angle',
    outletRatio: 'Outlet ratio',
    dFirst: 'Runner case Ø',
    dMiddle: 'Guide vanes Ø',
    hollowLength: 'Cone length',
    wallThickness: 'Wall thickness',
    centralDiameter: 'Generator Ø',
    centralHeight: 'Generator height',
    domeHeight: 'Dome height',
  };

  const onGenerate = handleSubmit(
    (v) => {
      // An inverted Min>Max is a contradiction the server refuses anyway —
      // surface it here without a round trip (the table cell shows which row).
      const inverted = (outputs ?? []).filter((o) => o.status === '! min>max');
      if (inverted.length) {
        const messages = inverted.map((o) => {
          const con = constraints[o.key];
          return `${o.label}: Min ${con?.min ?? '?'} > Max ${con?.max ?? '?'} — fix or clear those values.`;
        });
        setBuildWarnings([]);
        setBuildErrors(messages);
        toast.error('Inverted Min/Max range — see the notes below the preview.');
        return;
      }
      const body = { ...v, constraints };
      build.mutate(body, {
        onSuccess: (res) => {
          setHash(res.hash);
          setOfferMirror(Boolean(v.guideVanes) && res.stepHasVanes !== false);
          setLastBuildInput(body);
          setBuildErrors([]);
          setBuildWarnings(res.warnings ?? []);
          if (res.warnings?.length) {
            toast.warning('Chamber generated with warnings — see the notes below the preview.');
          } else {
            toast.success('Chamber generated.');
          }
        },
        onError: (err) => {
          const message =
            err instanceof ApiError ? err.message : 'Could not generate the chamber.';
          // Both places: the persistent notices panel and the top-right toast.
          // The previous build's warnings would sit confusingly under the new
          // red errors — clear them (nothing new was built).
          setBuildWarnings([]);
          setBuildErrors([message]);
          toast.error(message);
        },
      });
    },
    (fieldErrors) => {
      // Invalid submit: keep the inline field errors, and mirror a readable
      // summary into the notices panel + a toast so nothing stays only in the
      // form column.
      const messages = Object.entries(fieldErrors)
        .map(([key, err]) => {
          const label = FIELD_LABELS[key as keyof ChamberFormValues] ?? key;
          const detail = err && 'message' in err && err.message ? String(err.message) : 'Invalid value';
          return `${label}: ${detail}`;
        })
        .filter(Boolean);
      setBuildWarnings([]);
      setBuildErrors(messages.length ? messages : ['Fix the highlighted inputs.']);
      toast.error('Invalid inputs — see the notes below the preview.');
    },
  );

  // After an on-demand STEP/mirror generation, silently re-POST the built body
  // (a pure cache hit): new builder warnings (e.g. the vane-less STEP fallback)
  // reach the panel, and a discovered fallback collapses the STEP menu.
  const onExportDownloaded = (kind: ChamberExportKind) => {
    if (!lastBuildInput || (kind !== 'step' && kind !== 'stepMirrored')) return;
    void buildChamberRequest(lastBuildInput)
      .then((res) => {
        setOfferMirror(Boolean(lastBuildInput.guideVanes) && res.stepHasVanes !== false);
        const fresh = (res.warnings ?? []).filter((w) => !buildWarnings.includes(w));
        setBuildWarnings(res.warnings ?? []);
        if (fresh.length) {
          toast.warning('New build notes — see below the preview.');
        }
      })
      .catch(() => {
        // The download itself succeeded; a failed refresh changes nothing.
      });
  };

  // The preview/exports always show the LAST BUILT geometry; flag when the
  // form or constraints have drifted from it since Generate.
  const isStale =
    hash !== null &&
    lastBuildInput !== null &&
    JSON.stringify({ ...values, constraints }) !== JSON.stringify(lastBuildInput);

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
              // The loaded save is a DIFFERENT configuration: everything tied
              // to the previous build (viewer, exports, notices) is stale now.
              setHash(null);
              setOfferMirror(false);
              setLastBuildInput(null);
              setBuildWarnings([]);
              setBuildErrors([]);
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
            {isStale && (
              <p className="mb-3 rounded-sm border border-accent/40 bg-accent-tint px-3 py-2 text-xs text-text" role="status">
                Inputs changed since this build — the preview and downloads
                still show the previous geometry. Generate to refresh.
              </p>
            )}
            <ChamberExportButtons
              hash={hash}
              offerMirror={offerMirror}
              onDownloaded={onExportDownloaded}
            />
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

      <ChamberBuildWarnings warnings={buildWarnings} errors={buildErrors} />

      <ChamberOutputsTable
        outputs={outputs}
        constraints={constraints}
        onConstraintChange={onConstraintChange}
      />
    </div>
  );
}

export default ChamberPage;
