import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { fetchPublicConfig } from '../api';
import { createAdminTheme } from './createAdminTheme';
import { loadHostLook, loadThemeChoice, saveHostLook, saveThemeChoice } from './themeChoice';
import { isAdminThemeName, type AdminThemeName } from './themeNames';

import './fonts';

interface ThemeChoice {
  /** What the console wears: the admin's own pick, or else the host's default. */
  look: AdminThemeName;
  /** The admin's own pick in this browser, or null while they follow the host. */
  ownPick: AdminThemeName | null;
  /** The host's default, as `/api/config` answered it or, until it does, as this browser last heard it. */
  hostLook: AdminThemeName;
  /** Keeps a pick of the admin's own, or forgets it with null so the console follows the host. */
  chooseLook: (name: AdminThemeName | null) => void;
  /** Tells the console the host's default changed, after an admin saved a new one. */
}

const ThemeChoiceContext = createContext<ThemeChoice | null>(null);

/**
 * Dresses the console in its look and lets the switcher change it. The admin's own pick in this browser wins.
 * Without one the console wears the host's default from `/api/config`, and until that answers, the default this
 * browser last heard, so a returning visitor does not see the look flash. A config that cannot be read leaves that
 * look on. Holds MUI's theme provider and its baseline, so everything below reads the look.
 */
export function ThemeChoiceProvider({ children }: { children: ReactNode }) {
  const [ownPick, setOwnPick] = useState<AdminThemeName | null>(() => loadThemeChoice());
  const [hostLook, setHostLook] = useState<AdminThemeName>(() => loadHostLook());
  const look = ownPick ?? hostLook;
  const theme = useMemo(() => createAdminTheme(look), [look]);

  const wearHostLook = useCallback((name: AdminThemeName) => {
    saveHostLook(name);
    setHostLook(name);
  }, []);

  useEffect(() => {
    let current = true;
    fetchPublicConfig().then(
      (config) => {
        if (current && isAdminThemeName(config.defaultTheme)) wearHostLook(config.defaultTheme);
      },
      () => {
        // The console stays on the look it already wears. The pages that need the config say so themselves.
      },
    );
    return () => {
      current = false;
    };
  }, [wearHostLook]);

  const chooseLook = useCallback((name: AdminThemeName | null) => {
    saveThemeChoice(name);
    setOwnPick(name);
  }, []);

  const value = useMemo(() => ({ look, ownPick, hostLook, chooseLook }), [look, ownPick, hostLook, chooseLook]);

  return (
    <ThemeChoiceContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeChoiceContext.Provider>
  );
}

export function useThemeChoice(): ThemeChoice {
  const choice = useContext(ThemeChoiceContext);
  if (!choice) {
    throw new Error('useThemeChoice must be used within a ThemeChoiceProvider');
  }
  return choice;
}
