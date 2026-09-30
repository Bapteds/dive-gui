// Zod schemas for the convergence criteria endpoints (WS-G). The body schema is
// the shared contract (`cfdCriteriaSchema` in @dive/shared) so the web client
// validates the same shape; patch names are restricted to word characters since
// they are rendered into function objects.
import { cfdCriteriaSchema } from '@dive/shared';

/** Body of `PUT /projects/:id/criteria`. */
export const saveCriteriaSchema = cfdCriteriaSchema;
