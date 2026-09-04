// Saved chamber builds: named, team-shared snapshots of the exact
// POST /chamber/build body, so the Chamber form can be reloaded later instead
// of re-entering everything. The geometry itself stays in the hash-keyed build
// cache — a save carries only the request. Saving is always optional.
//
// Access model (mirrors templates):
//   - any authenticated user can list and load every save;
//   - only the author or a super-admin can overwrite, rename, or delete one.
import { Prisma } from '@prisma/client';
import type { ChamberInput, ChamberSaveSummary } from '@dive/shared';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import type { Viewer } from '../projects/projects.service';
import type { ChamberSaveCreateInput, ChamberSaveUpdateInput } from './chamber-saves.schemas';

const saveInclude = {
  owner: { select: { id: true, fullName: true } },
} satisfies Prisma.ChamberSaveInclude;
type SaveWithOwner = Prisma.ChamberSaveGetPayload<{ include: typeof saveInclude }>;

/** Detect Prisma's unique-constraint violation (P2002) on the name column. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Detect Prisma's record-not-found (P2025): the row vanished between the
 * manage-check and the write (two admins cleaning up concurrently). */
function isMissingRecord(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

function toPublicSave(save: SaveWithOwner): ChamberSaveSummary {
  return {
    id: save.id,
    name: save.name,
    // Written validated (chamberBuildSchema), so the parse cannot fail in
    // practice; a corrupted row surfaces as a 500 rather than bad data.
    snapshot: JSON.parse(save.snapshot) as ChamberInput,
    owner: { id: save.owner.id, fullName: save.owner.fullName },
    createdAt: save.createdAt.toISOString(),
    updatedAt: save.updatedAt.toISOString(),
  };
}

/** Can the viewer overwrite/rename/delete this save (author or super-admin)? */
function canManageSave(viewer: Viewer, save: { ownerId: string }): boolean {
  return viewer.role === 'SUPER_ADMIN' || save.ownerId === viewer.id;
}

/** Load a save (with owner) and assert the viewer may manage it. */
async function findManageableOrThrow(viewer: Viewer, id: string): Promise<SaveWithOwner> {
  const save = await prisma.chamberSave.findUnique({ where: { id }, include: saveInclude });
  if (!save) {
    throw new AppError(404, 'NOT_FOUND', 'Saved build not found');
  }
  if (!canManageSave(viewer, save)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the author can change this saved build');
  }
  return save;
}

/** List every save (shared), most recently updated first. */
export async function listChamberSaves(): Promise<ChamberSaveSummary[]> {
  const saves = await prisma.chamberSave.findMany({
    include: saveInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return saves.map(toPublicSave);
}

/** Create a save owned by the viewer. A taken name is a 409. */
export async function createChamberSave(
  viewer: Viewer,
  input: ChamberSaveCreateInput,
): Promise<ChamberSaveSummary> {
  try {
    const save = await prisma.chamberSave.create({
      data: {
        name: input.name,
        ownerId: viewer.id,
        snapshot: JSON.stringify(input.snapshot),
      },
      include: saveInclude,
    });
    return toPublicSave(save);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'NAME_TAKEN', `A saved build named "${input.name}" already exists`);
    }
    throw err;
  }
}

/** Overwrite the snapshot and/or rename (author or super-admin only). */
export async function updateChamberSave(
  viewer: Viewer,
  id: string,
  input: ChamberSaveUpdateInput,
): Promise<ChamberSaveSummary> {
  await findManageableOrThrow(viewer, id);
  try {
    const save = await prisma.chamberSave.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.snapshot !== undefined ? { snapshot: JSON.stringify(input.snapshot) } : {}),
      },
      include: saveInclude,
    });
    return toPublicSave(save);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'NAME_TAKEN', `A saved build named "${input.name}" already exists`);
    }
    if (isMissingRecord(err)) {
      throw new AppError(404, 'NOT_FOUND', 'Saved build not found');
    }
    throw err;
  }
}

/** Delete a save (author or super-admin only). deleteMany never throws for a
 * row that vanished concurrently — an already-deleted save is simply done. */
export async function deleteChamberSave(viewer: Viewer, id: string): Promise<void> {
  await findManageableOrThrow(viewer, id);
  await prisma.chamberSave.deleteMany({ where: { id } });
}
