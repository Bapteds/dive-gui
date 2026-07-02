import { describe, expect, it } from 'vitest';
import { parseTagInput, templateFormSchema } from './schemas';

describe('template form schema + tag parsing', () => {
  it('splits tags on commas/newlines, trims, and drops empties', () => {
    expect(parseTagInput('mesh, inlet,,  steady \n turbine')).toEqual([
      'mesh',
      'inlet',
      'steady',
      'turbine',
    ]);
    expect(parseTagInput('')).toEqual([]);
    expect(parseTagInput(undefined)).toEqual([]);
  });

  it('requires a path when starting from a single file', () => {
    expect(templateFormSchema.safeParse({ name: 'T', kind: 'file', path: '  ' }).success).toBe(false);
    expect(
      templateFormSchema.safeParse({ name: 'T', kind: 'file', path: 'system/fvSolution' }).success,
    ).toBe(true);
  });

  it('accepts an empty file set without a path', () => {
    expect(templateFormSchema.safeParse({ name: 'T', kind: 'set' }).success).toBe(true);
  });
});
