/**
 * Parse a numeric form field, HONORING a typed 0.
 *
 * `Number('')` is 0, so the old `Number(x) || fallback` idiom silently turned a
 * legitimate typed 0 (e.g. margin 0, feature level 0, feature angle 0) into the
 * fallback (M12). This distinguishes a BLANK field (use the fallback) from a
 * typed 0 (keep 0); a non-numeric string also falls back.
 */
export function numOr(value: string, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
