import { apiClient } from './client';
import type { DashboardData } from './types';

/** Fetch the Home dashboard aggregate (server metrics + the viewer's runs). */
export async function getDashboard(): Promise<DashboardData> {
  return apiClient.get<DashboardData>('/dashboard');
}
