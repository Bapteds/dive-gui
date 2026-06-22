import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Vite configuration for the DIVE Turbinen web app.
// The `@` alias mirrors the tsconfig `paths` entry so shadcn-style imports
// (e.g. `@/components/...`) resolve consistently in both the bundler and TS.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  // Pre-bundle app dependencies up front so the dev server does not pause to
  // re-optimize (and full-reload) when a lazy route such as Admin is first opened.
  optimizeDeps: {
    include: [
      '@dive/shared',
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
      'react-hook-form',
      '@hookform/resolvers/zod',
      'zod',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      '@radix-ui/react-slot',
      '@radix-ui/react-label',
      '@radix-ui/react-dialog',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-separator',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-avatar',
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // Split stable vendor code into long-term-cacheable chunks. Combined with
        // the route-level lazy imports, this shrinks the initial JS download.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('node_modules/react-router') || id.includes('node_modules/@remix-run'))
            return 'router';
          if (id.includes('node_modules/@radix-ui')) return 'radix';
          if (id.includes('node_modules/@tanstack')) return 'query';
          if (
            id.includes('node_modules/react-hook-form') ||
            id.includes('node_modules/@hookform') ||
            id.includes('node_modules/zod')
          )
            return 'forms';
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler')
          )
            return 'react';
          return 'vendor';
        },
      },
    },
  },
});
