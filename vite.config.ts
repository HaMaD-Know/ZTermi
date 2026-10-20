import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs: Capacitor serves the bundle from capacitor://localhost/.
  base: './',
  build: {
    outDir: 'dist',
    target: 'safari15',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
