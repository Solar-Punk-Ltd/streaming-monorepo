import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { createAdminTheme } from './createAdminTheme';
import { loadThemeChoice, saveThemeChoice } from './themeChoice';
import type { AdminThemeName } from './themeNames';

import './fonts';

interface ThemeChoice {
  look: AdminThemeName;
  chooseLook: (name: AdminThemeName) => void;
}

const ThemeChoiceContext = createContext<ThemeChoice | null>(null);

/**
 * Dresses the console in the look this browser picked, kept across reloads and sign-outs, and lets the
 * switcher change it. Holds MUI's theme provider and its baseline, so everything below reads the look.
 */
export function ThemeChoiceProvider({ children }: { children: ReactNode }) {
  const [look, setLook] = useState<AdminThemeName>(() => loadThemeChoice());
  const theme = useMemo(() => createAdminTheme(look), [look]);

  const chooseLook = useCallback((name: AdminThemeName) => {
    saveThemeChoice(name);
    setLook(name);
  }, []);

  const value = useMemo(() => ({ look, chooseLook }), [look, chooseLook]);

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
