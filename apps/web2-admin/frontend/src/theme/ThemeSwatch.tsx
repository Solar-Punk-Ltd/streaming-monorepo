import { Box } from '@mui/material';

import type { AdminThemeName } from './themeNames';
import { THEME_TOKENS } from './tokens';

/**
 * A small tile in one theme's page colour, accent and heading typeface, whatever the console wears, so
 * the switcher shows what each pick looks like before it is made.
 */
export function ThemeSwatch({ name }: { name: AdminThemeName }) {
  const { colors, fonts, headingWeight } = THEME_TOKENS[name];
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 28,
        height: 28,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: colors.background,
        color: colors.primary,
        fontFamily: fonts.heading,
        fontWeight: headingWeight ?? 500,
        fontSize: 13,
        lineHeight: 1,
      }}
    >
      Aa
    </Box>
  );
}
