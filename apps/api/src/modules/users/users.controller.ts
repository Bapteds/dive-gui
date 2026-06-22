// Users HTTP controllers. Thin adapters over the users service. All handlers
// run behind requireAuth + requireRole('SUPER_ADMIN') at the router level.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
  type Actor,
} from './users.service';
import type { CreateUserInput, UpdateUserInput } from './users.schemas';

/** GET /users — list every account. */
export async function listUsersController(_req: Request, res: Response): Promise<void> {
  const users = await listUsers();
  res.status(200).json({ users });
}

/** GET /users/:id — fetch a single account. */
export async function getUserController(req: Request, res: Response): Promise<void> {
  const user = await getUser(req.params.id);
  res.status(200).json({ user });
}

/** POST /users — create an account. */
export async function createUserController(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const user = await createUser(req.body as CreateUserInput, actor);
  res.status(201).json({ user });
}

/** PATCH /users/:id — update an account. */
export async function updateUserController(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const user = await updateUser(req.params.id, req.body as UpdateUserInput, actor);
  res.status(200).json({ user });
}

/** DELETE /users/:id — remove an account (guards apply in the service). */
export async function deleteUserController(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  await deleteUser(req.params.id, actor);
  res.status(204).send();
}

/** Extract the authenticated actor (id + email) or fail defensively. */
function requireActor(req: Request): Actor {
  if (!req.user) {
    // Defensive: every users route is behind requireAuth + requireRole.
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, email: req.user.email };
}
