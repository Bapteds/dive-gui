// Unit tests for the meshing storage name helpers (pure — no filesystem).
import { describe, expect, it } from 'vitest';
import { sanitizeStlName, slugifySessionName } from '../src/lib/meshingStorage';

describe('slugifySessionName', () => {
  it('lowercases, strips accents, and collapses separators to dashes', () => {
    expect(slugifySessionName('Draft Tube — v2')).toBe('draft-tube-v2');
    expect(slugifySessionName('Étage Röterné')).toBe('etage-roterne');
  });

  it('falls back to "session" when nothing survives', () => {
    expect(slugifySessionName('***')).toBe('session');
  });
});

describe('sanitizeStlName', () => {
  it('keeps a safe basename and forces the .stl extension', () => {
    expect(sanitizeStlName('rotor.stl')).toBe('rotor.stl');
    expect(sanitizeStlName('C:/tmp/rotor.STL')).toBe('rotor.stl');
    expect(sanitizeStlName('draft tube.obj')).toBe('draft_tube.stl');
  });

  it('strips path traversal to a bare basename', () => {
    expect(sanitizeStlName('../../etc/passwd.stl')).toBe('passwd.stl');
  });

  it('falls back to "surface" when the stem is empty', () => {
    expect(sanitizeStlName('.stl')).toBe('surface.stl');
  });
});
