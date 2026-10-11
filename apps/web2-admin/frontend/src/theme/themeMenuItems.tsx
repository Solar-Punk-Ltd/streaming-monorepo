import { ListItemIcon, ListItemText, ListSubheader, MenuItem } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

import { useThemeChoice } from './ThemeChoiceProvider';
import { ThemeSwatch } from './ThemeSwatch';
import { ADMIN_THEME_NAMES, type AdminThemeName } from './themeNames';
import { THEME_TOKENS } from './tokens';

interface ThemeItem {
  key: string;
  /** The look its swatch shows. */
  swatch: AdminThemeName;
  label: string;
  checked: boolean;
  onPick: () => void;
}

/** A plain function rather than a component, so the menu sees a MenuItem as its direct child. */
function themeItem({ key, swatch, label, checked, onPick }: ThemeItem) {
  return (
    <MenuItem
      key={key}
      role="menuitemradio"
      aria-checked={checked}
      selected={checked}
      onClick={onPick}
      sx={{ gap: 1.5, minHeight: 44 }}
    >
      <ThemeSwatch name={swatch} />
      <ListItemText>{label}</ListItemText>
      {checked && (
        <ListItemIcon sx={{ minWidth: 0, color: 'primary.main' }} aria-hidden="true">
          <CheckIcon fontSize="small" />
        </ListItemIcon>
      )}
    </MenuItem>
  );
}

/**
 * The switcher as items of a MUI menu: a heading, then "this host's look", which means no pick of the admin's own,
 * then one checkable item per theme. Returned as a list rather than a fragment, because a MUI menu reads its direct
 * children to move focus between them. Picking keeps the menu open, so the looks can be compared in place.
 */
export function useThemeMenuItems() {
  const { ownPick, hostLook, chooseLook } = useThemeChoice();

  return [
    <ListSubheader key="theme-heading" sx={{ lineHeight: '32px', bgcolor: 'transparent' }}>
      Theme
    </ListSubheader>,
    themeItem({
      key: 'theme-host',
      swatch: hostLook,
      label: `This host's look (${THEME_TOKENS[hostLook].label})`,
      checked: ownPick === null,
      onPick: () => chooseLook(null),
    }),
    ...ADMIN_THEME_NAMES.map((name) =>
      themeItem({
        key: `theme-${name}`,
        swatch: name,
        label: THEME_TOKENS[name].label,
        checked: ownPick === name,
        onPick: () => chooseLook(name),
      }),
    ),
  ];
}
