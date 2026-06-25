// Zod schema for the export download route param.
import { z } from 'zod';

/** Which downloadable export artifact a download request targets. */
export const exportArtifactParamSchema = z.object({
  id: z.string().min(1),
  artifact: z.enum(['ensight', 'session', 'memo', 'report']),
});

export type ExportArtifactParam = z.infer<typeof exportArtifactParamSchema>['artifact'];
