import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/features/auth/AuthProvider';

/**
 * Providers - composes the app-wide context providers.
 *
 * Order matters only loosely here: React Query and Tooltip are independent; the
 * AuthProvider wraps the routed tree so guards and the shell can read the
 * session. The QueryClient is created once via lazy state init so it survives
 * re-renders but is not shared across tests. The Toaster mounts once at the root.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Sensible defaults for an internal back office: avoid noisy refetches,
            // do not retry obvious client errors aggressively.
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={200} skipDelayDuration={300}>
          {children}
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
