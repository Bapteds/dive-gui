// Users router, mounted at /api/v1/users.
// Every route requires an authenticated SUPER_ADMIN. Validation is applied per
// route; handlers are wrapped with asyncHandler so thrown errors are forwarded.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import {
  createUserController,
  deleteUserController,
  getUserController,
  listUsersController,
  updateUserController,
} from './users.controller';
import {
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
} from './users.schemas';

/** Build the users router with role-guarded CRUD routes. */
export function createUsersRouter(): Router {
  const router = Router();

  // Guard the entire router: authenticated super-admins only.
  router.use(asyncHandler(requireAuth));
  router.use(requireRole('SUPER_ADMIN'));

  router.get('/', asyncHandler(listUsersController));

  router.post('/', validate({ body: createUserSchema }), asyncHandler(createUserController));

  router.get(
    '/:id',
    validate({ params: userIdParamSchema }),
    asyncHandler(getUserController),
  );

  router.patch(
    '/:id',
    validate({ params: userIdParamSchema, body: updateUserSchema }),
    asyncHandler(updateUserController),
  );

  router.delete(
    '/:id',
    validate({ params: userIdParamSchema }),
    asyncHandler(deleteUserController),
  );

  return router;
}
