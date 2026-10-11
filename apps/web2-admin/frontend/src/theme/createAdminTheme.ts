import { createTheme, type Theme } from '@mui/material';

import type { AdminThemeName } from './themeNames';
import { THEME_TOKENS, type ThemeTokens } from './tokens';

declare module '@mui/material/styles' {
  interface TypographyVariants {
    /** The typeface for values read character by character. Read it through `monoFont`. */
    fontFamilyMono: string;
  }
  interface TypographyVariantsOptions {
    fontFamilyMono?: string;
  }
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function headingTypography(tokens: ThemeTokens) {
  const weight = tokens.headingWeight === null ? {} : { fontWeight: tokens.headingWeight };
  return Object.fromEntries(HEADINGS.map((h) => [h, { fontFamily: tokens.fonts.heading, ...weight }]));
}

/** Turns one theme's tokens into the MUI theme the whole console reads. */
export function createAdminTheme(name: AdminThemeName): Theme {
  const tokens = THEME_TOKENS[name];
  const { colors } = tokens;

  return createTheme({
    palette: {
      mode: 'dark',
      background: { default: colors.background, paper: colors.surface },
      divider: colors.divider,
      text: { primary: colors.text, secondary: colors.textSecondary, disabled: colors.textDisabled },
      primary: { main: colors.primary, dark: colors.primaryHover, contrastText: colors.onPrimary },
      error: { main: colors.error },
      warning: { main: colors.warning },
      success: { main: colors.success },
      info: { main: colors.info },
    },
    typography: {
      fontFamily: tokens.fonts.base,
      fontFamilyMono: tokens.fonts.mono,
      ...headingTypography(tokens),
      button: { textTransform: tokens.buttonCase },
    },
    shape: { borderRadius: tokens.radius },
    components: {
      MuiAppBar: {
        styleOverrides: {
          root: { '--AppBar-background': colors.bar, ...(tokens.flatSurfaces ? { backgroundImage: 'none' } : {}) },
        },
      },
      ...(tokens.flatSurfaces ? { MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } } } : {}),
    },
  });
}

/** The theme's monospace typeface, for an `sx` prop: `sx={{ fontFamily: monoFont }}`. */
export function monoFont(theme: Theme): string {
  return theme.typography.fontFamilyMono;
}
