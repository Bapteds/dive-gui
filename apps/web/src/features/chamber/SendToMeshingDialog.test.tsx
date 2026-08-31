import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeshingSession, MeshingSessionSummary } from '@/lib/api/types';

/**
 * SendToMeshingDialog tests. The meshing API is mocked so the real dialog logic
 * runs: each mode builds the exact transfer body the API contract expects, a
 * missing selection never fires the transfer, success closes + navigates to the
 * target session, and a failed transfer keeps the dialog open.
 */

vi.mock('@/lib/api/meshing', () => ({
  listMeshingSessions: vi.fn(),
  transferChamberToMeshing: vi.fn(),
}));

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateSpy,
}));

import * as meshingApi from '@/lib/api/meshing';
import { SendToMeshingDialog } from './SendToMeshingDialog';

const HASH = '0123456789abcdef';

const SESSIONS: MeshingSessionSummary[] = [
  {
    id: 'sess-snappy',
    name: 'Draft tube',
    engine: 'snappy',
    createdAt: '2026-08-01T08:00:00.000Z',
    stlCount: 1,
    hasMesh: false,
  },
  {
    id: 'sess-cf',
    name: 'Volute',
    engine: 'cfmesh',
    createdAt: '2026-08-02T08:00:00.000Z',
    stlCount: 2,
    hasMesh: true,
  },
];

const CREATED = { id: 'sess-new' } as MeshingSession;

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SendToMeshingDialog hash={HASH} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(meshingApi.listMeshingSessions).mockResolvedValue(SESSIONS);
  vi.mocked(meshingApi.transferChamberToMeshing).mockResolvedValue(CREATED);
});

describe('SendToMeshingDialog', () => {
  it('defaults to a new snappy session named after the chamber hash', async () => {
    const onOpenChange = renderDialog();
    expect(screen.getByLabelText('Session name')).toHaveValue(`chamber-${HASH.slice(0, 8)}`);

    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    await waitFor(() =>
      expect(meshingApi.transferChamberToMeshing).toHaveBeenCalledWith({
        mode: 'new',
        chamberHash: HASH,
        name: `chamber-${HASH.slice(0, 8)}`,
        engine: 'snappy',
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(navigateSpy).toHaveBeenCalledWith('/meshing/sess-new');
  });

  it('sends the chosen engine for a new session', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('cfMesh'));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'My volute' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    await waitFor(() =>
      expect(meshingApi.transferChamberToMeshing).toHaveBeenCalledWith({
        mode: 'new',
        chamberHash: HASH,
        name: 'My volute',
        engine: 'cfmesh',
      }),
    );
  });

  it('refuses to send in existing mode until a session is picked', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Existing session'));
    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    // No selection: the transfer must never fire.
    await waitFor(() => expect(screen.getByLabelText('Target session')).toBeInTheDocument());
    expect(meshingApi.transferChamberToMeshing).not.toHaveBeenCalled();
  });

  it('sends an existing-session transfer with the picked id', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Existing session'));
    const select = await screen.findByLabelText('Target session');
    // The option list comes from the (mocked) sessions query; wait for it so the
    // select actually accepts the value (an unknown value coerces back to '').
    await screen.findByRole('option', { name: /Volute/ });
    fireEvent.change(select, { target: { value: 'sess-cf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    await waitFor(() =>
      expect(meshingApi.transferChamberToMeshing).toHaveBeenCalledWith({
        mode: 'existing',
        chamberHash: HASH,
        sessionId: 'sess-cf',
      }),
    );
  });

  it('sends a copyFrom transfer, omitting a blank new name', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Copy a setup'));
    const select = await screen.findByLabelText('Copy setup from');
    await screen.findByRole('option', { name: /Draft tube/ });
    fireEvent.change(select, { target: { value: 'sess-snappy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    await waitFor(() =>
      expect(meshingApi.transferChamberToMeshing).toHaveBeenCalledWith({
        mode: 'copyFrom',
        chamberHash: HASH,
        sourceId: 'sess-snappy',
        name: undefined,
      }),
    );
  });

  it('keeps the dialog open when the transfer fails', async () => {
    vi.mocked(meshingApi.transferChamberToMeshing).mockRejectedValue(new Error('boom'));
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Send to Meshing' }));
    await waitFor(() => expect(meshingApi.transferChamberToMeshing).toHaveBeenCalled());
    await waitFor(() => expect(navigateSpy).not.toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
