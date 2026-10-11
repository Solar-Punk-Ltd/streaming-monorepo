import { ListItemIcon, ListItemText, ListSubheader, MenuItem } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

import { useThemeChoice } from './ThemeChoiceProvider';
import { ThemeSwatch } from './ThemeSwatch';
import { ADMIN_THEME_NAMES } from './themeNames';
import { THEME_TOKENS } from './tokens';

/**
 * The switcher as items of a MUI menu: a heading and one checkable item per theme. Returned as a list
 * rather than a fragment, because a MUI menu reads its direct children to move focus between them.
 * Picking keeps the menu open, so the looks can be compared in place.
 */
export function useThemeMenuItems() {
  const { look, chooseLook } = useThemeChoice();

  return [
    <ListSubheader key="theme-heading" sx={{ lineHeight: '32px', bgcolor: 'transparent' }}>
      Theme
    </ListSubheader>,
    ...ADMIN_THEME_NAMES.map((name) => (
      <MenuItem
        key={`theme-${name}`}
        role="menuitemradio"
        aria-checked={look === name}
        selected={look === name}
        onClick={() => chooseLook(name)}
        sx={{ gap: 1.5, minHeight: 44 }}
      >
        <ThemeSwatch name={name} />
        <ListItemText>{THEME_TOKENS[name].label}</ListItemText>
        {look === name && (
          <ListItemIcon sx={{ minWidth: 0, color: 'primary.main' }} aria-hidden="true">
            <CheckIcon fontSize="small" />
          </ListItemIcon>
        )}
      </MenuItem>
    )),
  ];
}
