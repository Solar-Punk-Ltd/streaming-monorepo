import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Read through globalThis so the config typechecks with only vite/client types
// loaded (no @types/node in this package) — the manager's frontend does the same.
const WEB2_ADMIN_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_WEB2_ADMIN_URL ??
  'http://localhost:9877';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5081,
    // Everything the console calls lives under /api, so one prefix covers it.
    // Session cookies ride along because the proxy keeps the origin.
    //
    // `changeOrigin` stays off on purpose: with it, the proxy readdresses the
    // request to the API's own host and port, and the backend's cross-site
    // check then sees an `Origin` of this dev server against a `Host` of the
    // API and refuses every write, sign-in first. Off, the API is addressed
    // as the browser addressed it, which is what nginx does in production, so
    // development exercises the same rule rather than a softer one.
    proxy: {
      '/api': { target: WEB2_ADMIN_URL, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    restoreMocks: true,
    // 30 s, not vitest's 5 s. The page tests render a whole page in jsdom, the Funding page with its
    // tabs among them; the slowest take 0.5 to 0.8 s on a laptop, and a CI runner runs them several
    // times slower, enough to have pushed one past 5 s. The timeout is there to catch a hang, not to
    // time the page.
    testTimeout: 30_000,
  },
});
