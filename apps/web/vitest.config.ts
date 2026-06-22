import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest configuration for the DIVE Turbinen web app.
 *
 * Runs component tests in a jsdom environment with the React plugin and the
 * `@` path alias (mirroring vite.config.ts / tsconfig). A setup file registers
 * the jest-dom matchers and cleans up the DOM between tests. Kept separate from
 * vite.config.ts so the build/dev config stays untouched.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
