import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChamberInput, ChamberSaveSummary } from '@/lib/api/types';

/**
 * ChamberSavesMenu tests. The saves API and the session are mocked so the real
 * menu logic runs: loading a save hands its snapshot to the page, Save creates
 * or overwrites by name (someone else's name is refused inline), Rename /
 * Duplicate / Delete live behind the "more" menu with the author/admin guard,
 * and the empty state disables the dropdown.
 */

vi.mock('@/lib/api/chamberSaves', () => ({
  listChamberSaves: vi.fn(),
  createChamberSave: vi.fn(),
  updateChamberSave: vi.fn(),
  deleteChamberSave: vi.fn(),
}));

const authState = { user: { id: 'me', fullName: 'Me', role: 'USER' } };
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => authState,
}));

import * as savesApi from '@/lib/api/chamberSaves';
import { ChamberSavesMenu } from './ChamberSavesMenu';

const SNAPSHOT: ChamberInput = { x1: 1450, x2: 7.85, x3: 8 };

const MINE: ChamberSaveSummary = {
  id: 'save-mine',
  name: 'Runner A',
  snapshot: { ...SNAPSHOT, guideVanes: true },
  owner: { id: 'me', fullName: 'Me' },
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
};
const THEIRS: ChamberSaveSummary = {
  id: 'save-theirs',
  name: 'Runner B',
  snapshot: SNAPSHOT,
  owner: { id: 'them', fullName: 'Colleague' },
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};

function renderMenu(snapshot: ChamberInput | null = SNAPSHOT) {
  const onLoad = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ChamberSavesMenu snapshot={snapshot} onLoad={onLoad} />
    </QueryClientProvider>,
  );
  return onLoad;
}

const select = () => screen.getByLabelText('Load a saved build');

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: 'me', fullName: 'Me', role: 'USER' };
  vi.mocked(savesApi.listChamberSaves).mockResolvedValue([MINE, THEIRS]);
  vi.mocked(savesApi.createChamberSave).mockImplementation(async (body) => ({
    ...MINE,
    id: 'save-new',
    name: body.name,
    snapshot: body.snapshot,
  }));
  vi.mocked(savesApi.updateChamberSave).mockResolvedValue(MINE);
  vi.mocked(savesApi.deleteChamberSave).mockResolvedValue();
});

describe('ChamberSavesMenu', () => {
  it('disables the dropdown while there is nothing to load', async () => {
    vi.mocked(savesApi.listChamberSaves).mockResolvedValue([]);
    renderMenu();
    expect(await screen.findByText('No saved builds yet')).toBeInTheDocument();
    expect(select()).toBeDisabled();
  });

  it('loads the picked save into the form', async () => {
    const onLoad = renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-theirs');
    expect(onLoad).toHaveBeenCalledWith(THEIRS);
  });

  it('creates a new save from the save dialog', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Fresh config');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    // react-query passes a context object as a second mutationFn argument.
    await waitFor(() => expect(savesApi.createChamberSave).toHaveBeenCalled());
    expect(vi.mocked(savesApi.createChamberSave).mock.calls[0][0]).toEqual({
      name: 'Fresh config',
      snapshot: SNAPSHOT,
    });
  });

  it('overwrites the loaded save when the name is kept', async () => {
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-mine');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The dialog is prefilled with the loaded save's name.
    expect(screen.getByLabelText('Name')).toHaveValue('Runner A');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() =>
      expect(savesApi.updateChamberSave).toHaveBeenCalledWith('save-mine', {
        snapshot: SNAPSHOT,
      }),
    );
    expect(savesApi.createChamberSave).not.toHaveBeenCalled();
  });

  it("refuses to overwrite someone else's name with an inline error", async () => {
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Runner B');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    expect(await screen.findByText(/belongs to Colleague/)).toBeInTheDocument();
    expect(savesApi.updateChamberSave).not.toHaveBeenCalled();
    expect(savesApi.createChamberSave).not.toHaveBeenCalled();
  });

  it('disables Save while the form is invalid', async () => {
    renderMenu(null);
    await waitFor(() => expect(select()).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renames the selected save via the more menu (author)', async () => {
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-mine');
    await userEvent.click(screen.getByRole('button', { name: 'Saved build actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Runner A v2');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(savesApi.updateChamberSave).toHaveBeenCalledWith('save-mine', {
        name: 'Runner A v2',
      }),
    );
  });

  it("blocks Rename and Delete on someone else's save but allows Duplicate", async () => {
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-theirs');
    await userEvent.click(screen.getByRole('button', { name: 'Saved build actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    // Prefilled "<name> (copy)"; submitting posts the SOURCE snapshot as a copy.
    expect(screen.getByLabelText('Name')).toHaveValue('Runner B (copy)');
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(savesApi.createChamberSave).toHaveBeenCalled());
    expect(vi.mocked(savesApi.createChamberSave).mock.calls[0][0]).toEqual({
      name: 'Runner B (copy)',
      snapshot: THEIRS.snapshot,
    });
  });

  it('deletes the selected save after confirmation', async () => {
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-mine');
    await userEvent.click(screen.getByRole('button', { name: 'Saved build actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(savesApi.deleteChamberSave).toHaveBeenCalled());
    expect(vi.mocked(savesApi.deleteChamberSave).mock.calls[0][0]).toBe('save-mine');
  });

  it('lets a super-admin manage anyone’s save', async () => {
    authState.user = { id: 'admin', fullName: 'Admin', role: 'SUPER_ADMIN' };
    renderMenu();
    await waitFor(() => expect(select()).toBeEnabled());
    await userEvent.selectOptions(select(), 'save-theirs');
    await userEvent.click(screen.getByRole('button', { name: 'Saved build actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
