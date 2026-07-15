// Projects business logic, independent of Express.
//
// Visibility model:
//   - the owner and any collaborator can view a project;
//   - a super-admin can view every project;
//   - only the owner or a super-admin can manage it (delete, add/remove
//     collaborators). A plain collaborator cannot manage.
// Strangers get 404 (never 403) so a project's existence is not leaked.
import type { Prisma } from '@prisma/client';
import type { Role } from '../../lib/role';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { removeProjectStorage } from '../../lib/caseStorage';
import { stopProjectRuns } from './runs.service';
import { stopProjectStudies } from './studies.service';
import type { CreateProjectInput } from './projects.schemas';

/** Who is acting, used for visibility + management checks. */
export interface Viewer {
  id: string;
  role: Role;
}

/** Minimal public user shape embedded in a project (owner / collaborators). */
export interface UserSummary {
  id: string;
  fullName: string;
  email: string;
}

/** Public, wire-safe representation of a project. */
export interface PublicProject {
  id: string;
  title: string;
  owner: UserSummary;
  collaborators: UserSummary[];
  createdAt: string;
  updatedAt: string;
}

/** Include the owner + collaborators on every project query we serialize. */
const projectInclude = {
  owner: true,
  collaborators: { orderBy: { fullName: 'asc' } },
} satisfies Prisma.ProjectInclude;

type ProjectWithRelations = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function toUserSummary(user: { id: string; fullName: string; email: string }): UserSummary {
  return { id: user.id, fullName: user.fullName, email: user.email };
}

function toPublicProject(project: ProjectWithRelations): PublicProject {
  return {
    id: project.id,
    title: project.title,
    owner: toUserSummary(project.owner),
    collaborators: project.collaborators.map(toUserSummary),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/** Can the viewer see this project (owner, collaborator, or super-admin)? */
function canView(viewer: Viewer, project: ProjectWithRelations): boolean {
  return (
    viewer.role === 'SUPER_ADMIN' ||
    project.ownerId === viewer.id ||
    project.collaborators.some((c) => c.id === viewer.id)
  );
}

/** Can the viewer manage this project (owner or super-admin)? */
function canManage(viewer: Viewer, project: ProjectWithRelations): boolean {
  return viewer.role === 'SUPER_ADMIN' || project.ownerId === viewer.id;
}

/**
 * Load a project and enforce visibility. Returns 404 for an unknown id OR a
 * project the viewer may not see (no existence leak).
 */
async function findVisibleOrThrow(viewer: Viewer, id: string): Promise<ProjectWithRelations> {
  const project = await prisma.project.findUnique({ where: { id }, include: projectInclude });
  if (!project || !canView(viewer, project)) {
    throw new AppError(404, 'NOT_FOUND', 'Project not found');
  }
  return project;
}

/**
 * Assert the viewer may see this project, returning it. Used by sibling modules
 * (e.g. case files) to gate access without duplicating the visibility rule.
 * @throws 404 NOT_FOUND for an unknown id or a project the viewer may not see.
 */
export async function assertProjectVisible(viewer: Viewer, id: string): Promise<PublicProject> {
  const project = await findVisibleOrThrow(viewer, id);
  return toPublicProject(project);
}

/**
 * List the projects visible to the viewer, newest first. A super-admin sees
 * every project; everyone else sees the ones they own or collaborate on.
 */
export async function listProjects(viewer: Viewer): Promise<PublicProject[]> {
  const where: Prisma.ProjectWhereInput =
    viewer.role === 'SUPER_ADMIN'
      ? {}
      : {
          OR: [{ ownerId: viewer.id }, { collaborators: { some: { id: viewer.id } } }],
        };

  const projects = await prisma.project.findMany({
    where,
    include: projectInclude,
    orderBy: { createdAt: 'desc' },
  });
  return projects.map(toPublicProject);
}

/** Fetch a single visible project. */
export async function getProject(viewer: Viewer, id: string): Promise<PublicProject> {
  const project = await findVisibleOrThrow(viewer, id);
  return toPublicProject(project);
}

/** Create a project owned by the viewer. */
export async function createProject(
  ownerId: string,
  input: CreateProjectInput,
): Promise<PublicProject> {
  const project = await prisma.project.create({
    data: { title: input.title.trim(), ownerId },
    include: projectInclude,
  });
  return toPublicProject(project);
}

/** Delete a project. Owner or super-admin only. */
export async function deleteProject(viewer: Viewer, id: string): Promise<void> {
  const project = await findVisibleOrThrow(viewer, id);
  if (!canManage(viewer, project)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the project owner can delete this project');
  }
  // Stop any live solver first, or the ghost mpirun keeps burning cores for
  // hours after the run rows and case are gone (M3). Best-effort; never blocks.
  await stopProjectRuns(id).catch(() => undefined);
  await stopProjectStudies(id).catch(() => undefined);
  await prisma.project.delete({ where: { id } });
  // Best-effort cleanup of the on-disk case files; never fail the delete on it.
  await removeProjectStorage(id).catch(() => undefined);
}

/**
 * Add a collaborator to a project by email. Owner or super-admin only.
 * @throws 404 USER_NOT_FOUND if no account has that email, 409 COLLABORATOR_EXISTS
 *         if the user already owns or collaborates on the project.
 */
export async function addCollaborator(
  viewer: Viewer,
  id: string,
  email: string,
): Promise<PublicProject> {
  const project = await findVisibleOrThrow(viewer, id);
  if (!canManage(viewer, project)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the project owner can manage collaborators');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'No account exists with that email address');
  }
  if (user.id === project.ownerId) {
    throw new AppError(409, 'COLLABORATOR_EXISTS', 'The owner already has access to this project');
  }
  if (project.collaborators.some((c) => c.id === user.id)) {
    throw new AppError(409, 'COLLABORATOR_EXISTS', 'That user is already a collaborator');
  }

  const updated = await prisma.project.update({
    where: { id },
    data: { collaborators: { connect: { id: user.id } } },
    include: projectInclude,
  });
  return toPublicProject(updated);
}

/** Remove a collaborator from a project. Owner or super-admin only. */
export async function removeCollaborator(
  viewer: Viewer,
  id: string,
  collaboratorId: string,
): Promise<PublicProject> {
  const project = await findVisibleOrThrow(viewer, id);
  if (!canManage(viewer, project)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the project owner can manage collaborators');
  }
  if (!project.collaborators.some((c) => c.id === collaboratorId)) {
    throw new AppError(404, 'NOT_FOUND', 'That user is not a collaborator on this project');
  }

  const updated = await prisma.project.update({
    where: { id },
    data: { collaborators: { disconnect: { id: collaboratorId } } },
    include: projectInclude,
  });
  return toPublicProject(updated);
}
