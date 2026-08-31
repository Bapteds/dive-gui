import { apiClient } from './client';
import type { ChamberInput, ChamberSaveSummary } from './types';

/**
 * chamberSaves.ts - saved chamber builds (`/chamber/saves`): named, team-shared
 * snapshots of the exact `POST /chamber/build` body, so the Chamber form can be
 * reloaded instead of re-entered. Everyone can list and load every save; only
 * the author (or a super-admin) may overwrite, rename, or delete one.
 */

/** List every save, most recently updated first. */
export async function listChamberSaves(): Promise<ChamberSaveSummary[]> {
  const data = await apiClient.get<{ saves: ChamberSaveSummary[] }>('/chamber/saves');
  return data.saves;
}

/** Create a save owned by the current user (409 when the name is taken). */
export async function createChamberSave(body: {
  name: string;
  snapshot: ChamberInput;
}): Promise<ChamberSaveSummary> {
  const data = await apiClient.post<{ save: ChamberSaveSummary }>('/chamber/saves', body);
  return data.save;
}

/** Overwrite the snapshot and/or rename (author or super-admin only). */
export async function updateChamberSave(
  id: string,
  body: { name?: string; snapshot?: ChamberInput },
): Promise<ChamberSaveSummary> {
  const data = await apiClient.put<{ save: ChamberSaveSummary }>(`/chamber/saves/${id}`, body);
  return data.save;
}

/** Delete a save (author or super-admin only). */
export async function deleteChamberSave(id: string): Promise<void> {
  await apiClient.delete<void>(`/chamber/saves/${id}`);
}
