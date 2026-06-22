import { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { RedirectIfAuthenticated, RequireAuth, RequireRole } from './guards';

// Route components are code-split: each page becomes its own lazy chunk, so the
// initial load ships only what Login/Home need. The Admin chunk (its form and
// dialog dependencies) is fetched on demand the first time /admin is opened.
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const HomePage = lazy(() => import('@/pages/HomePage').then((m) => ({ default: m.HomePage })));
const AccountPage = lazy(() =>
  import('@/pages/AccountPage').then((m) => ({ default: m.AccountPage })),
);
const AdminPage = lazy(() => import('@/pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const ProjectsPage = lazy(() =>
  import('@/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import('@/pages/ProjectDetailPage').then((m) => ({ default: m.ProjectDetailPage })),
);
const ProjectEditPage = lazy(() =>
  import('@/pages/ProjectEditPage').then((m) => ({ default: m.ProjectEditPage })),
);
const TemplatesPage = lazy(() =>
  import('@/pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })),
);
const TemplateEditPage = lazy(() =>
  import('@/pages/TemplateEditPage').then((m) => ({ default: m.TemplateEditPage })),
);

/**
 * router.tsx - application route tree.
 *
 *  - /login is public; an already-authenticated user is redirected away.
 *  - The protected branch uses AppShell as its layout. Its children render in
 *    the shell's <Outlet/>: / (Home, any authenticated user) and /admin
 *    (super-admin only, wrapped in RequireRole).
 *  - Any unknown path redirects to Home (which itself redirects to /login when
 *    the user is not signed in).
 */
export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <RedirectIfAuthenticated>
        <Suspense fallback={<FullPageLoader />}>
          <LoginPage />
        </Suspense>
      </RedirectIfAuthenticated>
    ),
  },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'projects/:id/edit', element: <ProjectEditPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'templates/:id/edit', element: <TemplateEditPage /> },
      { path: 'account', element: <AccountPage /> },
      {
        path: 'admin',
        element: (
          <RequireRole role="SUPER_ADMIN">
            <AdminPage />
          </RequireRole>
        ),
      },
    ],
  },
  // Catch-all: send unknown paths Home.
  { path: '*', element: <Navigate to="/" replace /> },
]);
