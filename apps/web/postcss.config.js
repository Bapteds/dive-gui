// PostCSS configuration (ESM: this package is `"type": "module"`).
// Tailwind v3 runs through the `tailwindcss` plugin, then autoprefixer.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
