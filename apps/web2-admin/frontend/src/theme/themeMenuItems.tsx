import { ListItemIcon, ListItemText, ListSubheader, MenuItem } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

import { useThemeChoice } from './ThemeChoiceProvider';
import { ADMIN_THEME_NAMES, type AdminThemeName } from './themeNames';
import { THEME_TOKENS } from './tokens';

/** A plain function rather than a component, so the menu sees a MenuItem as its direct child. */
function themeItem(name: AdminThemeName, checked: boolean, onPick: () => void) {
  return (
    <MenuItem
      key={`theme-${name}`}
      role="menuitemradio"
      aria-checked={checked}
      selected={checked}
      onClick={onPick}
      sx={{ gap: 1.5, minHeight: 44 }}
    >
      <ListItemText>{THEME_TOKENS[name].label}</ListItemText>
      {checked && (
        <ListItemIcon sx={{ minWidth: 0, color: 'primary.main' }} aria-hidden="true">
          <CheckIcon fontSize="small" />
        </ListItemIcon>
      )}
    </MenuItem>
  );
}

/**
 * The switcher as items of a MUI menu: a heading, then one checkable item per look, checked on the look the
 * console wears. Returned as a list rather than a fragment, because a MUI menu reads its direct children to move focus
 * between them. Picking keeps the menu open, so the looks can be compared in place.
 */
export function useThemeMenuItems() {
  const { look, chooseLook } = useThemeChoice();

  return [
    <ListSubheader key="theme-heading" sx={{ lineHeight: '32px', bgcolor: 'transparent' }}>
      Theme
    </ListSubheader>,
    ...ADMIN_THEME_NAMES.map((name) => themeItem(name, look === name, () => chooseLook(name))),
  ];
}
