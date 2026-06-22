import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * cn - Merge class names with Tailwind-aware conflict resolution.
 *
 * `clsx` flattens conditional class inputs; `twMerge` then dedupes conflicting
 * Tailwind utilities (e.g. `px-2 px-4` -> `px-4`) so later classes win. Used by
 * every UI primitive to compose base styles with caller overrides.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
