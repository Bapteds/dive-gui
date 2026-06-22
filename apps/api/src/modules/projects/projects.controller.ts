// Projects HTTP controllers. Thin adapters over the projects service. All
// handlers run behind requireAuth at the router level and are visibility-scoped.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import {
  addCollaborator,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  removeCollaborator,
  type Viewer,
} from './projects.service';
import type { AddCollaboratorInput, CreateProjectInput } from './projects.schemas';

/** GET /projects — list the projects visible to the current user. */
export async function listProjectsController(req: Request, res: Response): Promise<void> {
  const projects = await listProjects(requireViewer(req));
  res.status(200).json({ projects });
}

/** POST /projects — create a project owned by the current user. */
export async function createProjectController(req: Request, res: Response): Promise<void> {
  const project = await createProject(requireViewer(req).id, req.body as CreateProjectInput);
  res.status(201).json({ project });
}

/** GET /projects/:id — fetch a single visible project. */
export async function getProjectController(req: Request, res: Response): Promise<void> {
  const project = await getProject(requireViewer(req), req.params.id);
  res.status(200).json({ project });
}

/** DELETE /projects/:id — delete a project (owner or super-admin). */
export async function deleteProjectController(req: Request, res: Response): Promise<void> {
  await deleteProject(requireViewer(req), req.params.id);
  res.status(204).send();
}

/** POST /projects/:id/collaborators — add a collaborator by email. */
export async function addCollaboratorController(req: Request, res: Response): Promise<void> {
  const { email } = req.body as AddCollaboratorInput;
  const project = await addCollaborator(requireViewer(req), req.params.id, email);
  res.status(200).json({ project });
}

/** DELETE /projects/:id/collaborators/:userId — remove a collaborator. */
export async function removeCollaboratorController(req: Request, res: Response): Promise<void> {
  const project = await removeCollaborator(requireViewer(req), req.params.id, req.params.userId);
  res.status(200).json({ project });
}

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    // Defensive: every projects route is behind requireAuth.
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}
