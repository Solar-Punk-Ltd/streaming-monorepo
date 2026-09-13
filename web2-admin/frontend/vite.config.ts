import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Read through globalThis so the config typechecks with only vite/client types
// loaded (no @types/node in this package) — the manager's frontend does the same.
const WEB2_ADMIN_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.VITE_WEB2_ADMIN_URL ?? 'http://localhost:9877';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5081,
    // Everything the console calls lives under /api, so one prefix covers it.
    // Session cookies ride along because the proxy keeps the origin.
    proxy: {
      '/api': WEB2_ADMIN_URL,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    restoreMocks: true,
  },
});
