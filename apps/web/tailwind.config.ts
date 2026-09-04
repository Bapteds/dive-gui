import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Tailwind configuration for DIVE Turbinen.
 *
 * This file is a pure MIRROR of `src/styles/tokens.css`: every semantic name
 * resolves to a CSS variable, so there is exactly one source of truth for the
 * palette, radii, shadows, and z-index. Components use semantic Tailwind
 * classes (e.g. `bg-primary`, `rounded-md`, `shadow-md`) and never raw values.
 *
 * `darkMode: 'class'` is configured but unused: the app ships light-only.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand: blue (primary)
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          light: 'var(--color-primary-light)',
          tint: 'var(--color-primary-tint)',
        },
        // Brand: orange (accent)
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--color-accent-hover)',
          tint: 'var(--color-accent-tint)',
          strong: 'var(--color-accent-strong)',
        },
        // Accessible CTA fill (white-bold label clears AA at normal text size)
        cta: 'var(--color-cta)',
        'cta-hover': 'var(--color-cta-hover)',
        // Brand: grey (neutral)
        neutral: {
          DEFAULT: 'var(--color-neutral)',
        },
        // Surfaces & text
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        text: {
          DEFAULT: 'var(--color-text)',
          secondary: 'var(--color-text-secondary)',
        },
        // Borders
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
        },
        // Functional signal colors
        success: {
          DEFAULT: 'var(--color-success)',
          tint: 'var(--color-success-tint)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          hover: 'var(--color-danger-hover)',
          tint: 'var(--color-danger-tint)',
        },
        // Focus ring
        'focus-ring': 'var(--color-focus-ring)',
        // Scrim behind dialogs / overlays
        scrim: 'var(--color-scrim)',
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
      },
      fontSize: {
        // Fixed product scale: [size, line-height]. See DESIGN.md section 3.
        xs: ['0.75rem', { lineHeight: '1rem' }], // 12 / 16
        sm: ['0.875rem', { lineHeight: '1.25rem' }], // 14 / 20
        base: ['1rem', { lineHeight: '1.5rem' }], // 16 / 24
        lg: ['1.125rem', { lineHeight: '1.75rem' }], // 18 / 28
        xl: ['1.25rem', { lineHeight: '1.75rem' }], // 20 / 28
        '2xl': ['1.5rem', { lineHeight: '2rem' }], // 24 / 32
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }], // 30 / 36
      },
      zIndex: {
        base: 'var(--z-base)',
        dropdown: 'var(--z-dropdown)',
        sticky: 'var(--z-sticky)',
        overlay: 'var(--z-overlay)',
        modal: 'var(--z-modal)',
        toast: 'var(--z-toast)',
        tooltip: 'var(--z-tooltip)',
      },
      maxWidth: {
        content: '1200px',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
      transitionDuration: {
        fast: '150ms',
        base: '200ms',
      },
      keyframes: {
        // Dialog / popover entrance: scale + fade per DESIGN.md.
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'overlay-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        'content-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'content-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.98)' },
        },
        // Skeleton shimmer sweep.
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'overlay-in': 'overlay-in 150ms var(--ease-out)',
        'overlay-out': 'overlay-out 150ms var(--ease-out)',
        'content-in': 'content-in 200ms var(--ease-out)',
        'content-out': 'content-out 150ms var(--ease-out)',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [animate],
};

export default config;
