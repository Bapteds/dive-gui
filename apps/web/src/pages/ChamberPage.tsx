import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Send } from 'lucide-react';
import {
  applyChamberSpiralToOutputs,
  chamberSpiralModelInput,
  computeChamberOutputs,
} from '@dive/shared';
import type {
  ChamberConstraint,
  ChamberInput,
  ChamberOutput,
  ChamberOutputKey,
  ChamberSpiralSummary,
} from '@/lib/api/types';
import { buildChamber as buildChamberRequest, type ChamberExportKind } from '@/lib/api/chamber';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { ChamberInputsForm, type ChamberAutoDims } from '@/features/chamber/ChamberInputsForm';
import {
  CHAMBER_FORM_DEFAULTS,
  chamberBodyKey,
  chamberBuildErrorMessage,
  chamberFormSchema,
  chamberInputToSpiralLength,
  chamberSpiralLengthBody,
  chamberInputToFormValues,
  computeChamberAutoDims,
  casingVelocity,
  semiSpiralToggle,
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

  const [constraints, setConstraints] = useState<
    Partial<Record<ChamberOutputKey, ChamberConstraint>>
  >({});
  // Semi-spiral Length Min / Max / Exact (spec 2026-09-30-spiral-length): not an
  // output key, so kept apart from `constraints`; sent only with the spiral on.
  const [spiralLength, setSpiralLength] = useState<ChamberConstraint>({});
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
  // Chamfer state before "Semi-spiral casing" was ticked (null = none saved).
  const chamferBeforeSpiral = useRef<boolean | null>(null);
  // Semi-spiral quality + derived box of the LAST build (kept in step with `hash`).
  const [lastSpiral, setLastSpiral] = useState<ChamberSpiralSummary | null>(null);
  const build = useBuildChamber();

  // "Open in Chamber" from an optimisation study (WS-H) hands a design over in
  // the router state: load it like a save, once, then drop it from history so
  // a reload or Back does not re-apply it over the user's edits.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const handed = (location.state as { chamberInput?: ChamberInput } | null)?.chamberInput;
    if (!handed) return;
    reset(chamberInputToFormValues(handed));
    setConstraints(chamberInputToConstraints(handed));
    setSpiralLength(chamberInputToSpiralLength(handed));
    navigate(location.pathname, { replace: true, state: null });
    // Only when a new hand-off arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const values = watch();
  // The build body's Length field: undefined unless the spiral is on and a value is typed.
  const spiralLengthBody = chamberSpiralLengthBody(values.semiSpiral, spiralLength);
  // The last build's spiral only describes the CURRENT inputs while nothing
  // drifted since Generate; otherwise its derived values would be stale.
  const lastBuildMatches =
    lastBuildInput !== null &&
    chamberBodyKey({ ...values, constraints, spiralLength: spiralLengthBody }) ===
      chamberBodyKey(lastBuildInput);
  const spiralSummary = values.semiSpiral && lastBuildMatches ? lastSpiral : null;
  const relationsKey = JSON.stringify(values.relations);
  const outputs = useMemo<ChamberOutput[] | null>(() => {
    const { x1, x2, x3, relationsMaster, relations, semiSpiral } = values;
    if (![x1, x2, x3].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return null;
    }
    // Semi-spiral casing: the derived rows ignore their constraints and read
    // 'from spiral' (the value arrives with the build), as on the server.
    const model = computeChamberOutputs(
      chamberSpiralModelInput({ x1, x2, x3, constraints, relationsMaster, relations, semiSpiral }),
    );
    return semiSpiral ? applyChamberSpiralToOutputs(model, spiralSummary?.boxMm ?? null) : model;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    values.x1,
    values.x2,
    values.x3,
    values.relationsMaster,
    values.semiSpiral,
    relationsKey,
    constraints,
    spiralSummary,
  ]);

  // Auto length shown on the (blank) length field = 2 x the final width (mm).
  const widthFinal = outputs?.find((o) => o.key === 'width')?.final ?? null;
  const autoLengthMm = widthFinal != null ? 2 * widthFinal : null;
  // Semi-spiral casing: the Casing flow velocity follows B Kammer live (user
  // rule 2026-09-30), from the same shared helper the API builds with.
  const casing = useMemo(
    () => casingVelocity(values, constraints, outputs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      outputs,
      constraints,
      values.dFirst,
      values.dMiddle,
      values.partScale,
      values.coneChamferEnabled,
      values.coneChamferSize,
    ],
  );

  // Auto (empirical) placeholders for the manual dimension overrides + X4 —
  // the same shared model the API resolves with, computed from the CURRENT
  // form values so typed upstream overrides cascade into the hints exactly
  // like the build (a typed Generator Ø re-bases the height/dome hints).
  const finalOf = (key: ChamberOutputKey) => outputs?.find((o) => o.key === key)?.final ?? null;
  const autoDims: ChamberAutoDims = computeChamberAutoDims(values, finalOf('dLast'), {
    heightFinal: finalOf('height'),
    lebFinal: finalOf('hMiddlePlusFirst'),
    partScale: values.partScale,
  });

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
  const saveSnapshot = isValid
    ? { ...values, constraints, spiralLength: spiralLengthBody }
    : null;

  const onSpiralLengthChange = (field: keyof ChamberConstraint, value: number | undefined) => {
    setSpiralLength((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
  };

  // Field labels for the invalid-submit summary, mirroring the Inputs form.
  const FIELD_LABELS: Partial<Record<keyof ChamberFormValues, string>> = {
    x1: 'Runner Ø (mm)',
    x2: 'Head (m)',
    x3: 'Q_max (m³/s)',
    x4: 'Power (kW)',
    lengthOverride: 'Length',
    footAngleDeg: 'Foot angle',
    partScale: 'Part scale',
    vaneAngleDeg: 'Vane angle',
    vaneCount: 'Guide vane count',
    outletRatio: 'Outlet ratio',
    dFirst: 'Runner case Ø',
    dMiddle: 'Guide vanes Ø',
    hollowLength: 'Cone length',
    wallThickness: 'Wall thickness',
    coneChamferSize: 'Cone chamfer size',
    centralDiameter: 'Generator Ø',
    centralHeight: 'Generator height',
    domeHeight: 'Dome height',
    feetEnabled: 'Feet',
  };

  const onGenerate = handleSubmit(
    (v) => {
      // An inverted Min>Max is a contradiction the server refuses anyway —
      // surface it here without a round trip (the table cell shows which row).
      const inverted = (outputs ?? []).filter((o) => o.status === '! min>max');
      const lengthBody = chamberSpiralLengthBody(v.semiSpiral, spiralLength);
      const lengthInverted =
        lengthBody !== undefined &&
        lengthBody.exact == null &&
        lengthBody.min != null &&
        lengthBody.max != null &&
        lengthBody.min > lengthBody.max;
      if (inverted.length || lengthInverted) {
        const messages = inverted.map((o) => {
          const con = constraints[o.key];
          return `${o.label}: Min ${con?.min ?? '?'} > Max ${con?.max ?? '?'} — fix or clear those values.`;
        });
        if (lengthInverted) {
          messages.push(
            `Length: Min ${lengthBody.min} > Max ${lengthBody.max}. Fix or clear those values.`,
          );
        }
        setBuildWarnings([]);
        setBuildErrors(messages);
        toast.error('Inverted Min/Max range — see the notes below the preview.');
        return;
      }
      const body = { ...v, constraints, spiralLength: lengthBody };
      build.mutate(body, {
        onSuccess: (res) => {
          setHash(res.hash);
          setOfferMirror(Boolean(v.guideVanes) && res.stepHasVanes !== false);
          setLastBuildInput(body);
          setLastSpiral(res.spiral ?? null);
          setBuildErrors([]);
          setBuildWarnings(res.warnings ?? []);
          if (res.warnings?.length) {
            toast.warning('Chamber generated with warnings — see the notes below the preview.');
          } else {
            toast.success('Chamber generated.');
          }
        },
        onError: (err) => {
          const message = chamberBuildErrorMessage(err);
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
          const detail =
            err && 'message' in err && err.message ? String(err.message) : 'Invalid value';
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
  // form or constraints have drifted from it since Generate. Compared via
  // chamberBodyKey: the two objects hold their keys in different orders
  // (watch() registration order vs zod parse output in schema order).
  const isStale = hash !== null && lastBuildInput !== null && !lastBuildMatches;

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
              setSpiralLength(chamberInputToSpiralLength(save.snapshot));
              // The loaded save is a DIFFERENT configuration: everything tied
              // to the previous build (viewer, exports, notices) is stale now.
              setHash(null);
              setOfferMirror(false);
              setLastBuildInput(null);
              setLastSpiral(null);
              chamferBeforeSpiral.current = null;
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
            simplifyGenerator={values.simplifyGenerator}
            coneChamferEnabled={values.coneChamferEnabled}
            semiSpiral={values.semiSpiral}
            onSemiSpiralChange={(on) => {
              // Feet / Chamfer off with the spiral, Chamfer restored when it goes.
              const next = semiSpiralToggle(on, values, chamferBeforeSpiral.current);
              chamferBeforeSpiral.current = next.savedChamfer;
              if (next.set.feetEnabled !== undefined) {
                setValue('feetEnabled', next.set.feetEnabled, {
                  shouldValidate: true,
                  shouldDirty: true,
                });
              }
              if (next.set.chamferEnabled !== undefined) {
                setValue('chamferEnabled', next.set.chamferEnabled, { shouldDirty: true });
              }
            }}
            autoLengthMm={autoLengthMm}
            casingVelocity={casing}
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
              <p
                className="mb-3 rounded-sm border border-accent/40 bg-accent-tint px-3 py-2 text-xs text-text"
                role="status"
              >
                Inputs changed since this build — the preview and downloads still show the previous
                geometry. Generate to refresh.
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
            {hash && <SendToMeshingDialog hash={hash} open={sendOpen} onOpenChange={setSendOpen} />}
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
                <Loader2
                  className="size-6 animate-spin text-primary"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
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
        spiral={{
          on: values.semiSpiral,
          summary: spiralSummary,
          length: spiralLength,
          onLengthChange: onSpiralLengthChange,
        }}
      />
    </div>
  );
}

export default ChamberPage;
