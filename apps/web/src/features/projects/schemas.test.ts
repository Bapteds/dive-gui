import { describe, expect, it } from 'vitest';
import { PROJECT_TITLE_MAX_LENGTH } from '@dive/shared';
import { createProjectSchema } from './schemas';

/**
 * createProjectSchema tests: a project needs a non-empty, length-bounded title.
 */
describe('createProjectSchema', () => {
  it('accepts a normal title', () => {
    const result = createProjectSchema.safeParse({ title: 'Rotor stage study' });
    expect(result.success).toBe(true);
  });

  it('trims and rejects a blank title', () => {
    const result = createProjectSchema.safeParse({ title: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects a title longer than the shared maximum', () => {
    const result = createProjectSchema.safeParse({ title: 'a'.repeat(PROJECT_TITLE_MAX_LENGTH + 1) });
    expect(result.success).toBe(false);
  });
});
