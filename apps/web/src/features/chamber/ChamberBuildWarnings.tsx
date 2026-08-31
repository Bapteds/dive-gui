import { AlertTriangle } from 'lucide-react';

/**
 * ChamberBuildWarnings - the geometry clamp/fallback notices the builder emitted
 * for the current build (hollow stack scaled to fit H Kammer, outlet radius
 * clamped, STEP vane fallback). Previously these only reached the server log;
 * the API now returns and persists them per build. Renders nothing for a clean
 * build. Announced as an alert since it appears in response to Generate.
 */
export function ChamberBuildWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-accent/40 bg-accent-tint p-4 shadow-sm"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-accent-hover">
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
  );
}

export default ChamberBuildWarnings;
