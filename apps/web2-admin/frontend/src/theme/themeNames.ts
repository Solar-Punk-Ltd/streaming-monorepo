/** Every look the console carries, by the name the switcher saves. */
export const ADMIN_THEME_NAMES = ['default', 'swarm', 'web3privacy'] as const;

export type AdminThemeName = (typeof ADMIN_THEME_NAMES)[number];

/** Worn until an admin picks another: the console's own dark look, as it was before the switcher. */
export const DEFAULT_ADMIN_THEME: AdminThemeName = 'default';

export function isAdminThemeName(value: unknown): value is AdminThemeName {
  return typeof value === 'string' && (ADMIN_THEME_NAMES as readonly string[]).includes(value);
}
