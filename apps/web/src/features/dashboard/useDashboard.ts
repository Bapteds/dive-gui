import { useQuery } from '@tanstack/react-query';
import { getDashboard } from '@/lib/api/dashboard';
import type { DashboardData } from '@/lib/api/types';

/** How often the dashboard polls the server for live metrics + running solvers. */
const POLL_MS = 3000;

export const dashboardQueryKey = ['dashboard'] as const;

/** Poll the Home dashboard aggregate (server metrics + the viewer's runs). */
export function useDashboardQuery() {
  return useQuery<DashboardData>({
    queryKey: dashboardQueryKey,
    queryFn: getDashboard,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}
