import { AlertTriangle, XCircle } from 'lucide-react';

/**
 * ChamberBuildWarnings - the build notices panel between the preview and the
 * Parameters table. Two blocks, each rendered only when it has content:
 *
 *  - errors (red): why the last Generate produced nothing — a refused build
 *    (e.g. the stepped shoulder does not fit H Kammer) or invalid inputs. The
 *    same message also reaches the top-right toast; this panel is the readable,
 *    persistent copy.
 *  - warnings (orange): the geometry clamp/fallback notices the builder emitted
 *    for a SUCCESSFUL build (hollow stack scaled to fit H Kammer, outlet radius
 *    clamped, STEP vane fallback). Returned and persisted per build by the API.
 *
 * Renders nothing for a clean build. Announced as an alert since it appears in
 * response to Generate.
 */
export function ChamberBuildWarnings({
  warnings,
  errors = [],
}: {
  warnings: string[];
  errors?: string[];
}) {
  if (warnings.length === 0 && errors.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-4">
      {errors.length > 0 && (
        <div className="rounded-md border border-danger/40 bg-danger-tint p-4 shadow-sm">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger">
            <XCircle className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            Build errors
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            The chamber was not generated:
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-text">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-accent/40 bg-accent-tint p-4 shadow-sm">
          {/* accent-strong: the lighter oranges miss AA 4.5:1 at this size on the tint. */}
          <p className="flex items-center gap-2 text-sm font-semibold text-accent-strong">
            <AlertTriangle className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            Build warnings
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            The chamber was built, but the builder adjusted the geometry to make it fit:
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-text">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default ChamberBuildWarnings;
