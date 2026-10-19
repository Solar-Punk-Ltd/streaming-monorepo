import { DEFAULT_ADMIN_THEME, isAdminThemeName, type AdminThemeName } from './themeNames';

/** The look this browser's admin picked for themselves. */
export const THEME_CHOICE_STORAGE_KEY = 'web2-admin-theme';

/** The host's default look as this browser last heard it, worn until `/api/config` answers again. */
export const HOST_THEME_STORAGE_KEY = 'web2-admin-theme-host';

/** What of the browser's storage this needs, so a test can hand it one in memory. */
export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The look kept under `key`, or null when none is kept, when it is one the console no longer carries, or when the
 * browser refuses the page its storage.
 */
function loadLook(key: string, storage: ThemeStorage | null): AdminThemeName | null {
  try {
    const saved = storage?.getItem(key);
    return isAdminThemeName(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveLook(key: string, name: AdminThemeName | null, storage: ThemeStorage | null): void {
  try {
    if (name === null) storage?.removeItem(key);
    else storage?.setItem(key, name);
  } catch {
    // The look holds for this visit and is not remembered.
  }
}

/** The look this browser's admin picked for themselves, or null to follow the host. */
export function loadThemeChoice(storage: ThemeStorage | null = browserStorage()): AdminThemeName | null {
  return loadLook(THEME_CHOICE_STORAGE_KEY, storage);
}

/** Keeps the admin's own pick, or forgets it with null, so the console follows the host again. */
export function saveThemeChoice(name: AdminThemeName | null, storage: ThemeStorage | null = browserStorage()): void {
  saveLook(THEME_CHOICE_STORAGE_KEY, name, storage);
}

/** The host's default as this browser last heard it, or `DEFAULT_ADMIN_THEME` before it ever did. */
export function loadHostLook(storage: ThemeStorage | null = browserStorage()): AdminThemeName {
  return loadLook(HOST_THEME_STORAGE_KEY, storage) ?? DEFAULT_ADMIN_THEME;
}

export function saveHostLook(name: AdminThemeName, storage: ThemeStorage | null = browserStorage()): void {
  saveLook(HOST_THEME_STORAGE_KEY, name, storage);
}
