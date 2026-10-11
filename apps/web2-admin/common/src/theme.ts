/**
 * The console's looks, by the names both sides use: the switcher saves one in the browser, and the host's default is
 * stored in the admin's database and answered on `GET /api/config`. What each look is made of lives in the console,
 * `frontend/src/theme/tokens.ts`.
 */

/** Every look the console carries, by the name the switcher saves and the database stores. */
export const ADMIN_THEME_NAMES = ['default', 'swarm', 'web3privacy'] as const;

export type AdminThemeName = (typeof ADMIN_THEME_NAMES)[number];

/** Worn when nothing chose another: the console's own dark look, as it was before the switcher. */
export const DEFAULT_ADMIN_THEME: AdminThemeName = 'default';

export function isAdminThemeName(value: unknown): value is AdminThemeName {
  return typeof value === 'string' && (ADMIN_THEME_NAMES as readonly string[]).includes(value);
}

/** `PUT`, behind the session and for admins only: the look this host's console starts in. */
export const CONSOLE_DEFAULT_THEME_PATH = '/api/config/default-theme';

/** PUT /api/config/default-theme. A name the console does not carry is refused with 400 `validation_error`. */
export interface SetDefaultThemeRequest {
  defaultTheme: AdminThemeName;
}

/** The look stored, which `GET /api/config` answers from then on. */
export interface SetDefaultThemeResponse {
  defaultTheme: AdminThemeName;
}
