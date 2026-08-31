import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { getChamberExport, type ChamberExportKind } from '@/lib/api/chamber';

/**
 * ChamberExportButtons - download the built chamber as STL, STEP, or an OpenFOAM
 * triSurface zip. The endpoints require the bearer token, so a plain <a href>
 * cannot carry auth: each button fetches the artifact as a Blob (via the api
 * client) and triggers a transient object-URL download. Disabled until a build
 * exists.
 */

const EXPORTS: { kind: ChamberExportKind; label: string; filename: string }[] = [
  { kind: 'stl', label: 'STL', filename: 'chamber.stl' },
  { kind: 'step', label: 'STEP', filename: 'chamber.step' },
  { kind: 'trisurface', label: 'OpenFOAM triSurface', filename: 'chamber-trisurface.zip' },
];

export function ChamberExportButtons({ hash }: { hash: string | null }) {
  const [busy, setBusy] = useState<ChamberExportKind | null>(null);

  async function download(kind: ChamberExportKind, filename: string) {
    if (!hash) return;
    setBusy(kind);
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
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the export.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {EXPORTS.map((e) => (
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
      ))}
    </div>
  );
}

export default ChamberExportButtons;
