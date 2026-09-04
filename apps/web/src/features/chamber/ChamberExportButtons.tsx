import { useRef, useState } from 'react';
import { ChevronDown, Download, FlipHorizontal2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { getChamberExport, type ChamberExportKind } from '@/lib/api/chamber';

/**
 * ChamberExportButtons - download the built chamber as STL, STEP, or an OpenFOAM
 * triSurface zip. The endpoints require the bearer token, so a plain <a href>
 * cannot carry auth: each button fetches the artifact as a Blob (via the api
 * client) and triggers a transient object-URL download. Disabled until a build
 * exists.
 *
 * For guide-vane builds (offerMirror) the STEP button becomes a menu with the
 * plain download plus "Change rotational direction" — the same build mirrored
 * on the z-y plane. Vane builds DEFER the STEP export (the blade carve is ~2/3
 * of the build), so the first STEP download of a build regenerates it
 * server-side (~a build's worth of waiting, announced by an info toast; cached
 * after, and the mirrored variant reuses it).
 */

const EXPORTS: { kind: ChamberExportKind; label: string; filename: string }[] = [
  { kind: 'stl', label: 'STL', filename: 'chamber.stl' },
  { kind: 'step', label: 'STEP', filename: 'chamber.step' },
  { kind: 'trisurface', label: 'OpenFOAM triSurface', filename: 'chamber-trisurface.zip' },
];

export function ChamberExportButtons({
  hash,
  offerMirror = false,
  onDownloaded,
}: {
  hash: string | null;
  /** Guide-vane build whose STEP is not a known vane-less fallback: shows the
   * STEP menu (plain + "Change rotational direction"), both generated on
   * demand at first download. */
  offerMirror?: boolean;
  /** Fired after a SUCCESSFUL download — the page uses it to refresh the
   * build's warnings/meta after an on-demand STEP generation. */
  onDownloaded?: (kind: ChamberExportKind) => void;
}) {
  const [busy, setBusy] = useState<ChamberExportKind | null>(null);
  // Kinds already downloaded for the CURRENT hash: a repeat is served from the
  // build cache, so the "can take a minute" heads-up would be noise.
  const downloadedRef = useRef<{ hash: string | null; kinds: Set<ChamberExportKind> }>({
    hash: null,
    kinds: new Set(),
  });

  async function download(kind: ChamberExportKind, filename: string) {
    if (!hash) return;
    if (downloadedRef.current.hash !== hash) {
      downloadedRef.current = { hash, kinds: new Set() };
    }
    setBusy(kind);
    if (
      offerMirror &&
      (kind === 'step' || kind === 'stepMirrored') &&
      !downloadedRef.current.kinds.has(kind)
    ) {
      toast.info('Preparing the STEP export — the first download of a build can take a minute.');
    }
    try {
      const blob = await getChamberExport(hash, kind);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      downloadedRef.current.kinds.add(kind);
      onDownloaded?.(kind);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the export.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {EXPORTS.map((e) =>
        e.kind === 'step' && offerMirror ? (
          <DropdownMenu key={e.kind}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!hash}
                loading={busy === 'step' || busy === 'stepMirrored'}
              >
                <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
                {e.label}
                <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => void download('step', e.filename)}>
                <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Download STEP
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void download('stepMirrored', 'chamber-mirrored.step')}>
                <FlipHorizontal2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Change rotational direction
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            key={e.kind}
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hash}
            loading={busy === e.kind}
            onClick={() => void download(e.kind, e.filename)}
          >
            <Download className="size-4" strokeWidth={1.75} aria-hidden="true" />
            {e.label}
          </Button>
        ),
      )}
    </div>
  );
}

export default ChamberExportButtons;
