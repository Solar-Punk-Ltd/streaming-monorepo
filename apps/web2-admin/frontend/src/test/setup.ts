import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans when vitest globals are on; they are not.
afterEach(cleanup);

// The auth provider remembers in localStorage that this browser was signed in,
// so a reload can say the session ended. One test's sign-in must not become the
// next test's ended session.
afterEach(() => localStorage.clear());

// jsdom has no matchMedia, and MUI's responsive helpers call it on mount.
// Reporting "no match" puts every component in its widest layout, which is
// the one the console is designed for.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
