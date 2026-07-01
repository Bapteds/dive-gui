import { useEffect, useId, useMemo, useState } from 'react';
import { Box, Loader2 } from 'lucide-react';
import { MERGE_BASE_CASE } from '@/lib/api/types';
import { useCaseFilesQuery } from '@/features/projects/useCaseFiles';
import { useMeshesQuery } from '@/features/projects/useMeshes';
import { MeshViewer, type MeshTarget } from './MeshViewer';

/**
 * VisualizePanel - the "Visualize" tab body. It owns the mesh TARGET and a picker
 * that switches the 3D viewer between the project case mesh (constant/polyMesh)
 * and any imported library source, then renders <MeshViewer target=... />.
 *
 * The viewer is remounted per target (via `key`) so its scene, selection, and
 * dialogs reset cleanly when the shown mesh changes. The picker only appears when
 * there is an actual choice (a case mesh AND at least one library source), so a
 * project with just the case mesh looks exactly as it did before.
 */

/** Compact native select, with explicit surface + text colour (Windows dark-mode safe). */
const SELECT_CLASS =
  'min-w-[13rem] max-w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

export function VisualizePanel({ projectId }: { projectId: string }) {
  const selectId = useId();
  const casesQuery = useCaseFilesQuery(projectId);
  const meshesQuery = useMeshesQuery(projectId);

  const hasPolyMesh = useMemo(
    () => !!casesQuery.data?.some((entry) => entry.path.startsWith('constant/polyMesh/')),
    [casesQuery.data],
  );
  const sources = useMemo(() => meshesQuery.data ?? [], [meshesQuery.data]);

  const [target, setTarget] = useState<MeshTarget | null>(null);

  // Pick a default once the case tree + library have loaded, and reconcile if the
  // current source disappears (deleted) or is renamed. Default: the case mesh when
  // present, else the first library source.
  useEffect(() => {
    if (casesQuery.isPending || meshesQuery.isPending) return;
    setTarget((current) => {
      if (current?.kind === 'case') {
        if (hasPolyMesh) return current;
      } else if (current?.kind === 'source') {
        const still = sources.find((s) => s.id === current.meshId);
        if (still) {
          return still.name === current.name
            ? current
            : { kind: 'source', meshId: still.id, name: still.name };
        }
      }
      if (hasPolyMesh) return { kind: 'case' };
      if (sources.length > 0) return { kind: 'source', meshId: sources[0].id, name: sources[0].name };
      return null;
    });
  }, [hasPolyMesh, sources, casesQuery.isPending, meshesQuery.isPending]);

  const optionCount = (hasPolyMesh ? 1 : 0) + sources.length;
  const showPicker = optionCount > 1;

  const selectValue =
    target?.kind === 'case' ? MERGE_BASE_CASE : target?.kind === 'source' ? target.meshId : '';

  const handlePick = (value: string) => {
    if (value === MERGE_BASE_CASE) {
      setTarget({ kind: 'case' });
      return;
    }
    const source = sources.find((s) => s.id === value);
    if (source) setTarget({ kind: 'source', meshId: source.id, name: source.name });
  };

  // The viewer is keyed by target so switching gives a clean scene + fresh state.
  const targetKey = target ? (target.kind === 'case' ? 'case' : `source:${target.meshId}`) : 'none';

  const loading = casesQuery.isPending || meshesQuery.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {showPicker && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <label htmlFor={selectId} className="text-sm font-medium text-text">
            Mesh
          </label>
          <select
            id={selectId}
            value={selectValue}
            onChange={(event) => handlePick(event.currentTarget.value)}
            className={SELECT_CLASS}
          >
            {hasPolyMesh && <option value={MERGE_BASE_CASE}>Project case mesh</option>}
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          {target?.kind === 'source' && (
            <span className="text-xs text-text-secondary">
              Library part, edited independently of the case mesh.
            </span>
          )}
        </div>
      )}

      {target ? (
        <MeshViewer key={targetKey} projectId={projectId} target={target} />
      ) : (
        <PanelPlaceholder loading={loading} />
      )}
    </div>
  );
}

/** Loading (queries in flight) or empty (nothing to visualise yet) placeholder. */
function PanelPlaceholder({ loading }: { loading: boolean }) {
  return (
    <div
      className="flex min-h-[45vh] flex-1 flex-col items-center justify-center gap-3 rounded-md border border-border bg-surface px-6 py-12 text-center shadow-sm"
      role="status"
      aria-live="polite"
    >
      {loading ? (
        <>
          <Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
          <p className="text-sm text-text-secondary">Loading meshes&hellip;</p>
        </>
      ) : (
        <>
          <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
            <Box className="size-6 text-primary" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <div className="flex max-w-xs flex-col gap-1">
            <p className="text-base font-semibold text-text">Nothing to visualize</p>
            <p className="text-sm text-text-secondary">
              Import a mesh into the case, or add a part to the library, to preview it here.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default VisualizePanel;
