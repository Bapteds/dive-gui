/// <reference types="vite/client" />

// Typed access to the app's Vite environment variables (import.meta.env).
interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
