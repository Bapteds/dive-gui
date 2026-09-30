import type { StudyEvaluation, StudyVortexMetric } from '@dive/shared';

/**
 * studyFormat - display helpers of the Optimisation tab (WS-H), kept out of the
 * component files so React fast refresh stays component-only.
 */

/** Display name and unit of each WS-G vortex metric. */
export const VORTEX_METRIC_LABEL: Record<StudyVortexMetric, { name: string; unit: string }> = {
  maskedQVolume: { name: 'Masked Q volume', unit: 'm³' },
  omegaRms: { name: 'RMS vorticity', unit: '1/s' },
};

/** The picked vortex value of an evaluation. */
export function vortexOf(e: StudyEvaluation, metric: StudyVortexMetric): number | null {
  return metric === 'omegaRms' ? e.omegaRms : e.maskedQVolume;
}
