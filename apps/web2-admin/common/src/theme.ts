/**
 * The console's looks, by the names both sides use: the switcher saves one in the browser, and the host's default is
 * stored in the admin's database and answered on `GET /api/config`. What each look is made of lives in the console,
 * `frontend/src/theme/tokens.ts`.
 */

/** Every look the console carries, by the name the switcher saves and the database stores. */
export const ADMIN_THEME_NAMES = ['swarm', 'web3privacy'] as const;

export type AdminThemeName = (typeof ADMIN_THEME_NAMES)[number];

/**
 * Worn when nothing chose another, including a host whose stored default is a look the console no longer carries,
 * such as the Default look retired on 2026-10-12.
 */
export const DEFAULT_ADMIN_THEME: AdminThemeName = 'swarm';

export function isAdminThemeName(value: unknown): value is AdminThemeName {
  return typeof value === 'string' && (ADMIN_THEME_NAMES as readonly string[]).includes(value);
}
