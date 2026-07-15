/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  test: {
    // lib/engine tests are headless by design (no DOM, no renderer);
    // storage tests bring their own fakes (fake-indexeddb, in-memory Storage).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
