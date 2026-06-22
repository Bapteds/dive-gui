import { RouterProvider } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { router } from '@/app/router';

/**
 * App - the application root.
 *
 * Wraps the router in the app-wide providers (React Query, auth, tooltip,
 * toaster). All visual structure lives below the router; this component just
 * wires the two together.
 */
export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
