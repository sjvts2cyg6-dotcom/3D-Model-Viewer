import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Model files live in public/ and are fetched at runtime, never inlined.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
      },
    },
  },
  server: { host: true },
});
