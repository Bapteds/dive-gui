import { describe, expect, it } from 'vitest';
import { numOr } from './formNumber';

describe('numOr (M12: honor a typed 0)', () => {
  it('keeps a typed 0 instead of falling back to the default', () => {
    // The whole point of the fix: margin 0 / feature level 0 / angle 0 are valid.
    expect(numOr('0', 0.1)).toBe(0);
    expect(numOr('0', 45)).toBe(0);
  });

  it('falls back on a blank or whitespace-only field', () => {
    expect(numOr('', 0.1)).toBe(0.1);
    expect(numOr('   ', 2)).toBe(2);
  });

  it('falls back on a non-numeric value', () => {
    expect(numOr('abc', 45)).toBe(45);
  });

  it('parses a normal number', () => {
    expect(numOr('2.5', 1)).toBe(2.5);
    expect(numOr('-3', 1)).toBe(-3);
  });
});
