import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Single source of truth: repo-root .env (VITE_* only; DISPATCHER_* stay unprefixed and unpublished).
  envDir: path.resolve(__dirname, '..'),
  server: {
    port: 5173,
    // Fail rather than silently using 5174 — Redirect URLs are allow-listed for 5173.
    strictPort: true,
  },
});
