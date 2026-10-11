import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTheme, useTheme } from '@mui/material';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../components/AppShell';
import { createAdminTheme } from '../theme/createAdminTheme';
import { loadThemeChoice, saveThemeChoice, THEME_CHOICE_STORAGE_KEY, type ThemeStorage } from '../theme/themeChoice';
import { ADMIN_THEME_NAMES, DEFAULT_ADMIN_THEME, type AdminThemeName } from '../theme/themeNames';
import { THEME_TOKENS } from '../theme/tokens';
import { makeUser, renderWithProviders } from './helpers';

vi.mock('../auth', () => ({ useAuth: () => ({ user: makeUser({ username: 'ada' }), logOut: vi.fn() }) }));
vi.mock('../components/BuildVersion', () => ({ BuildVersion: () => null }));

const SRC = join(import.meta.dirname, '..');

const REFUSING: ThemeStorage = {
  getItem: () => {
    throw new Error('refused');
  },
  setItem: () => {
    throw new Error('refused');
  },
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('the looks', () => {
  it.each(ADMIN_THEME_NAMES)('%s becomes a dark MUI theme with its own accent and typefaces', (name) => {
    const theme = createAdminTheme(name);
    const tokens = THEME_TOKENS[name];

    expect(theme.palette.mode).toBe('dark');
    expect(theme.palette.primary.main).toBe(tokens.colors.primary);
    expect(theme.palette.background.default).toBe(tokens.colors.background);
    expect(theme.typography.fontFamily).toBe(tokens.fonts.base);
    expect(theme.typography.fontFamilyMono).toBe(tokens.fonts.mono);
    expect(theme.typography.h1.fontFamily).toBe(tokens.fonts.heading);
    expect(theme.shape.borderRadius).toBe(tokens.radius);
  });

  it("keeps the console's look from before the switcher as Default", () => {
    const stock = createTheme({ palette: { mode: 'dark' } });
    const ours = createAdminTheme(DEFAULT_ADMIN_THEME);

    expect(ours.palette.background).toEqual(stock.palette.background);
    expect(ours.palette.text).toEqual(stock.palette.text);
    expect(ours.palette.divider).toBe(stock.palette.divider);
    for (const key of ['primary', 'error', 'warning', 'success', 'info'] as const) {
      expect(ours.palette[key]).toEqual(stock.palette[key]);
    }
    expect(ours.typography.fontFamily).toBe(stock.typography.fontFamily);
    expect(ours.typography.h1.fontWeight).toBe(stock.typography.h1.fontWeight);
    expect(ours.shape.borderRadius).toBe(stock.shape.borderRadius);
  });
});

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const shortHex = value.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) {
    const [r, g, b] = [...shortHex[1]].map((digit) => Number.parseInt(digit + digit, 16));
    return [r, g, b, 1];
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map((part) => Number.parseFloat(part));
    return [r, g, b, a];
  }
  throw new Error(`not a colour the contrast check reads: ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

type ColorName = keyof (typeof THEME_TOKENS)['default']['colors'];

/** Contrast of a text colour on a surface in one theme, both composited over the page background. */
function contrast(name: AdminThemeName, text: ColorName, surface: ColorName): number {
  const { colors } = THEME_TOKENS[name];
  const page = parseColor(colors.background);
  const back = over(parseColor(colors[surface]), page);
  const front = over(parseColor(colors[text]), back);
  const [light, dark] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Every pairing of words and ground the console puts on screen. */
const TEXT_ON_SURFACE: Array<[ColorName, ColorName]> = [
  ['text', 'background'],
  ['text', 'surface'],
  ['text', 'bar'],
  ['textSecondary', 'background'],
  ['textSecondary', 'surface'],
  ['onPrimary', 'primary'],
  ['onPrimary', 'primaryHover'],
  ['primary', 'background'],
  ['primary', 'surface'],
  ['error', 'surface'],
  ['warning', 'surface'],
  ['success', 'surface'],
  ['info', 'surface'],
];

describe.each(ADMIN_THEME_NAMES)('the words of the %s look', (name) => {
  it.each(TEXT_ON_SURFACE)('%s on %s read at 4.5:1 or better', (text, surface) => {
    expect(contrast(name, text, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const COMPONENT_SOURCES = sourceFiles(SRC)
  .filter((path) => !path.startsWith(join(SRC, 'theme')) && !path.startsWith(join(SRC, 'test')))
  .map((path) => ({ path: relative(SRC, path), code: readFileSync(path, 'utf8') }));

const WRITTEN_OUT_STYLE = /['"]#[0-9a-f]{3,8}['"]|\b(?:rgba?|hsla?)\(|fontFamily:\s*['"]/gi;

describe('the components', () => {
  it('catch a colour or a typeface written out instead of read from the theme', () => {
    const code = "sx={{ color: '#fff', bgcolor: 'rgba(0, 0, 0, 0.5)', fontFamily: 'monospace' }}";
    expect(code.match(WRITTEN_OUT_STYLE)).toEqual(["'#fff'", 'rgba(', "fontFamily: '"]);
  });

  it.each(COMPONENT_SOURCES)('$path leaves its colours and typefaces to the theme', ({ code }) => {
    expect(code.match(WRITTEN_OUT_STYLE) ?? []).toEqual([]);
  });
});

describe('the pick', () => {
  it('is the default until one is made, and read back once it is', () => {
    expect(loadThemeChoice()).toBe(DEFAULT_ADMIN_THEME);
    saveThemeChoice('swarm');
    expect(loadThemeChoice()).toBe('swarm');
  });

  it('falls back to the default for a look the console no longer carries', () => {
    localStorage.setItem(THEME_CHOICE_STORAGE_KEY, 'retired');
    expect(loadThemeChoice()).toBe(DEFAULT_ADMIN_THEME);
  });

  it('holds for the visit when the browser refuses its storage', () => {
    expect(() => saveThemeChoice('swarm', REFUSING)).not.toThrow();
    expect(loadThemeChoice(REFUSING)).toBe(DEFAULT_ADMIN_THEME);
  });
});

/** What the console wears right now, read from inside it. */
function WornAccent() {
  return <span data-testid="accent">{useTheme().palette.primary.main}</span>;
}

function openUserMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'ada' }));
  return screen.getByRole('menu');
}

describe('the switcher in the user menu', () => {
  it('offers every look, the worn one checked', () => {
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );
    const menu = openUserMenu();

    expect(within(menu).getByText('Theme')).toBeInTheDocument();
    for (const name of ADMIN_THEME_NAMES) {
      const item = within(menu).getByRole('menuitemradio', { name: THEME_TOKENS[name].label });
      expect(item).toHaveAttribute('aria-checked', String(name === DEFAULT_ADMIN_THEME));
    }
  });

  it('dresses the console in the picked look, keeps the menu open, and keeps the pick', () => {
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );
    const menu = openUserMenu();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Web3Privacy' }));

    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.web3privacy.colors.primary);
    expect(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Web3Privacy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(loadThemeChoice()).toBe('web3privacy');
  });

  it('opens on its first item, not on the checked look', () => {
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );
    openUserMenu();

    expect(document.activeElement).toHaveTextContent('Streams');
  });

  it('wears the kept pick when the console opens again', () => {
    saveThemeChoice('swarm');
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );

    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
  });
});
