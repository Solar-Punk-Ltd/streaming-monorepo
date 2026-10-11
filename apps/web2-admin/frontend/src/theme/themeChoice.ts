import { DEFAULT_ADMIN_THEME, isAdminThemeName, type AdminThemeName } from './themeNames';

export const THEME_CHOICE_STORAGE_KEY = 'web2-admin-theme';

/** What of the browser's storage this needs, so a test can hand it one in memory. */
export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The look this browser picked before, or the default when it picked none, when the console no longer
 * carries the one it picked, or when the browser refuses the page its storage.
 */
export function loadThemeChoice(storage: ThemeStorage | null = browserStorage()): AdminThemeName {
  try {
    const saved = storage?.getItem(THEME_CHOICE_STORAGE_KEY);
    return isAdminThemeName(saved) ? saved : DEFAULT_ADMIN_THEME;
  } catch {
    return DEFAULT_ADMIN_THEME;
  }
}

export function saveThemeChoice(name: AdminThemeName, storage: ThemeStorage | null = browserStorage()): void {
  try {
    storage?.setItem(THEME_CHOICE_STORAGE_KEY, name);
  } catch {
    // The pick holds for this visit and is not remembered.
  }
}
