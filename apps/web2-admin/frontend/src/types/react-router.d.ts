import type { NavigateOptions, To } from 'react-router';

/**
 * This app mounts a declarative router (HashRouter, and MemoryRouter in tests), where navigate() returns
 * nothing. react-router 8 types it as void | Promise<void> to cover its data routers as well, and its own
 * documentation recommends narrowing it like this for a declarative one.
 */
declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void;
    (delta: number): void;
  }
}
