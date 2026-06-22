import { describe, expect, it } from 'vitest';
import { changePasswordSchema, profileSchema } from './schemas';

/**
 * Account form schema tests.
 *
 * Locks the self-service validation rules: the profile name trims and is
 * bounded; the password change requires a current password, an 8+ char new
 * password, a matching confirmation, and a new password different from the
 * current one (with the error attached to the right field).
 */
describe('profileSchema', () => {
  it('accepts and trims a valid name', () => {
    const result = profileSchema.safeParse({ fullName: '  Katharina Vogel  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fullName).toBe('Katharina Vogel');
    }
  });

  it('rejects a whitespace-only name', () => {
    expect(profileSchema.safeParse({ fullName: '   ' }).success).toBe(false);
  });

  it('rejects a name longer than 120 characters', () => {
    expect(profileSchema.safeParse({ fullName: 'a'.repeat(121) }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  const valid = {
    currentPassword: 'Sup3rSecret!',
    newPassword: 'Brand-New-Pass-1',
    confirmPassword: 'Brand-New-Pass-1',
  };

  it('accepts a valid change', () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the current password', () => {
    expect(changePasswordSchema.safeParse({ ...valid, currentPassword: '' }).success).toBe(false);
  });

  it('requires the new password to be at least 8 characters', () => {
    const result = changePasswordSchema.safeParse({
      ...valid,
      newPassword: 'short',
      confirmPassword: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('flags a non-matching confirmation on the confirm field', () => {
    const result = changePasswordSchema.safeParse({ ...valid, confirmPassword: 'Different-Pass-2' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('confirmPassword'))).toBe(true);
    }
  });

  it('flags a new password equal to the current one on the new-password field', () => {
    const same = 'Sup3rSecret!';
    const result = changePasswordSchema.safeParse({
      currentPassword: same,
      newPassword: same,
      confirmPassword: same,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('newPassword'))).toBe(true);
    }
  });
});
