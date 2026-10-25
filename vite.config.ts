import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Model files live in public/ and are fetched at runtime, never inlined.
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
