import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * Global test setup.
 *
 * Registers the jest-dom matchers (`toBeDisabled`, `toBeInTheDocument`, ...) on
 * Vitest's `expect` and unmounts any rendered React tree after each test so
 * cases stay isolated. jsdom lacks `matchMedia`, which Radix/sonner probe; a
 * minimal stub keeps those components from throwing during render.
 */
afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
