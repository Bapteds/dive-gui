// Admin / diagnostic tools: user management (SUPER_ADMIN), the audit log, and
// the public server feature-flag config (handy for a connectivity check).
import { z } from 'zod';
import type { Api } from '../client.js';
import type { Registrar } from '../kit.js';

export function registerAdminTools(tool: Registrar, api: Api): void {
  // ---- Users (SUPER_ADMIN) ----------------------------------------------
  tool('list_users', {
    title: 'List users (admin)',
    description: 'List all users. Requires the service account to have the SUPER_ADMIN role.',
  }, async () => api.get('/users'));

  tool('get_user', {
    title: 'Get user (admin)',
    description: 'Fetch a single user by id. Requires SUPER_ADMIN.',
    inputSchema: { userId: z.string().min(1).describe('User id.') },
  }, async ({ userId }) => api.get(`/users/${userId}`));

  tool('create_user', {
    title: 'Create user (admin)',
    description: 'Create a user account. Requires SUPER_ADMIN.',
    inputSchema: {
      fullName: z.string().min(1).describe("The user's full name."),
      email: z.string().email().describe("The user's email address."),
      password: z.string().describe('Initial password.'),
      role: z.enum(['SUPER_ADMIN', 'USER']).describe("The account role."),
    },
  }, async ({ fullName, email, password, role }) =>
    api.post('/users', { fullName, email, password, role }));

  tool('update_user', {
    title: 'Update user (admin)',
    description: "Update a user's fields (name, email, password, role, isActive). Provide at least one. Requires SUPER_ADMIN.",
    inputSchema: {
      userId: z.string().min(1).describe('User id to update.'),
      fullName: z.string().min(1).optional().describe('New full name.'),
      email: z.string().email().optional().describe('New email.'),
      password: z.string().optional().describe('New password.'),
      role: z.enum(['SUPER_ADMIN', 'USER']).optional().describe('New role.'),
      isActive: z.boolean().optional().describe('Enable (true) or disable (false) the account.'),
    },
  }, async ({ userId, fullName, email, password, role, isActive }) => {
    const body: Record<string, unknown> = {};
    if (fullName !== undefined) body.fullName = fullName;
    if (email !== undefined) body.email = email;
    if (password !== undefined) body.password = password;
    if (role !== undefined) body.role = role;
    if (isActive !== undefined) body.isActive = isActive;
    return api.patch(`/users/${userId}`, body);
  });

  tool('delete_user', {
    title: 'Delete user (admin)',
    description: 'Delete a user account. Irreversible. Requires SUPER_ADMIN.',
    inputSchema: { userId: z.string().min(1).describe('User id to delete.') },
    destructive: true,
  }, async ({ userId }) => {
    await api.delete(`/users/${userId}`);
    return { deleted: userId };
  });

  // ---- Audit log (SUPER_ADMIN) ------------------------------------------
  tool('list_audit_logs', {
    title: 'List audit logs (admin)',
    description: 'List recent audit-log entries (newest first). Requires SUPER_ADMIN.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50, max 200).'),
    },
  }, async ({ limit }) => api.get('/audit-logs', limit ? { limit } : undefined));

  // ---- Server config / connectivity -------------------------------------
  tool('get_server_config', {
    title: 'Get server config',
    description:
      'Fetch the public server feature flags (e.g. terminalEnabled). Also serves as a quick API connectivity check.',
  }, async () => api.get('/config'));
}
