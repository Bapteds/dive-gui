import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { FromChamberBody, MeshingEngine } from '@/lib/api/types';
import { useMeshingSessions, useTransferChamberToMeshing } from '@/features/meshing/useMeshing';

type Mode = 'new' | 'existing' | 'copyFrom';

/**
 * SendToMeshingDialog - transfer the built chamber (identified by `hash`) into a
 * meshing session. Three modes: a new session (name + engine), an existing
 * session, or a copy of an existing session's setup with the geometry injected.
 * On success, navigates to the target session so the imported surfaces show.
 */
export function SendToMeshingDialog({
  hash,
  open,
  onOpenChange,
}: {
  hash: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const transfer = useTransferChamberToMeshing();
  const { data: sessions } = useMeshingSessions();

  const [mode, setMode] = useState<Mode>('new');
  const [name, setName] = useState(`chamber-${hash.slice(0, 8)}`);
  const [engine, setEngine] = useState<MeshingEngine>('snappy');
  const [sessionId, setSessionId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [copyName, setCopyName] = useState('');

  const list = sessions ?? [];

  function buildBody(): FromChamberBody | null {
    if (mode === 'new') return { mode: 'new', chamberHash: hash, name: name.trim(), engine };
    if (mode === 'existing') {
      if (!sessionId) return null;
      return { mode: 'existing', chamberHash: hash, sessionId };
    }
    if (!sourceId) return null;
    return { mode: 'copyFrom', chamberHash: hash, sourceId, name: copyName.trim() || undefined };
  }

  async function onConfirm() {
    const body = buildBody();
    if (!body) {
      toast.error('Choose a session first.');
      return;
    }
    try {
      const session = await transfer.mutateAsync(body);
      toast.success('Sent to Meshing.');
      onOpenChange(false);
      navigate(`/meshing/${session.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send to Meshing.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to Meshing</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SegmentedRadioGroup
            name="send-mode"
            value={mode}
            onChange={(v) => setMode(v)}
            ariaLabel="Transfer mode"
            stretch
            options={[
              { value: 'new', label: 'New session' },
              { value: 'existing', label: 'Existing session' },
              { value: 'copyFrom', label: 'Copy a setup' },
            ]}
          />

          {mode === 'new' && (
            <>
              <Field label="Session name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-text">Mesh engine</legend>
                <SegmentedRadioGroup
                  name="send-engine"
                  value={engine}
                  onChange={(v) => setEngine(v)}
                  ariaLabel="Mesh engine"
                  options={[
                    { value: 'snappy', label: 'snappyHexMesh' },
                    { value: 'cfmesh', label: 'cfMesh' },
                  ]}
                />
              </fieldset>
            </>
          )}

          {mode === 'existing' && (
            <Field label="Target session">
              <NativeSelect value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">Select a session…</option>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}

          {mode === 'copyFrom' && (
            <>
              <Field label="Copy setup from">
                <NativeSelect value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">Select a session…</option>
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="New session name (optional)">
                <Input
                  value={copyName}
                  onChange={(e) => setCopyName(e.target.value)}
                  placeholder="Defaults to “<source> (copy)”"
                />
              </Field>
            </>
          )}

          {(mode === 'existing' || mode === 'copyFrom') && (
            <p className="text-xs text-text-secondary">
              Patches with the same name replace existing surfaces; other surfaces already in the
              session are kept.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={transfer.isPending} onClick={() => void onConfirm()}>
            Send to Meshing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SendToMeshingDialog;
