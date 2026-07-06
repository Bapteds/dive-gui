import { apiClient } from './client';
import type { ApplyBoundaryConditionsRequest, ApplyBoundaryConditionsResult } from '@dive/shared';

/**
 * boundary.ts - the "boundary conditions" overlay endpoint (authenticated,
 * project-visibility scoped). Applies a component BC preset to the case's 0/
 * fields.
 */

interface ApplyBoundaryConditionsResponse {
  result: ApplyBoundaryConditionsResult;
}

/**
 * Apply a component boundary-condition preset. Sends the plan as a multipart
 * `payload` JSON field plus an optional CSV file (the draft-tube runner-exit
 * profile). Resolves with the report even when the CSV -> boundaryData step
 * failed; only validation / transport errors reject as ApiError.
 */
export async function applyBoundaryConditions(
  projectId: string,
  request: ApplyBoundaryConditionsRequest,
  csv?: File | null,
): Promise<ApplyBoundaryConditionsResult> {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  if (csv) form.append('csv', csv, csv.name);
  const data = await apiClient.postForm<ApplyBoundaryConditionsResponse>(
    `/projects/${projectId}/boundary-conditions/apply`,
    form,
  );
  return data.result;
}
