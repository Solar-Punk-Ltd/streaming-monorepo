import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { useTheme } from '@mui/material';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../components/AppShell';
import { createAdminTheme } from '../theme/createAdminTheme';
import {
  HOST_THEME_STORAGE_KEY,
  loadHostLook,
  loadThemeChoice,
  saveHostLook,
  saveThemeChoice,
  THEME_CHOICE_STORAGE_KEY,
  type ThemeStorage,
} from '../theme/themeChoice';
import { ADMIN_THEME_NAMES, DEFAULT_ADMIN_THEME, type AdminThemeName } from '../theme/themeNames';
import { THEME_TOKENS } from '../theme/tokens';
import { jsonError, jsonOk, makeUser, mockFetch, renderWithProviders } from './helpers';

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
  removeItem: () => {
    throw new Error('refused');
  },
};

const CONFIG = '/api/config';

/** The public config as a host answers it, wearing `defaultTheme` unless the browser picked its own. */
function hostConfig(defaultTheme: string) {
  return {
    feed: { owner: 'a'.repeat(40), topic: 'catalogue', topicHex: 'b'.repeat(64) },
    viewerBaseUrl: null,
    defaultTheme,
  };
}

/** A host whose default is `defaultTheme`, and the fetch mock answering for it. */
function hostSays(defaultTheme: string) {
  return mockFetch([{ path: CONFIG, respond: () => jsonOk(hostConfig(defaultTheme)) }]);
}

/** The host's config route, answered with `respond`. */
function hostAnswers(respond: () => Response | Promise<Response>) {
  return mockFetch([{ path: CONFIG, respond }]);
}

beforeEach(() => {
  localStorage.clear();
  hostSays(DEFAULT_ADMIN_THEME);
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

type ColorName = keyof (typeof THEME_TOKENS)['swarm']['colors'];

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
  it('is none until one is made, read back once it is, and none again once forgotten', () => {
    expect(loadThemeChoice()).toBeNull();
    saveThemeChoice('swarm');
    expect(loadThemeChoice()).toBe('swarm');
    saveThemeChoice(null);
    expect(loadThemeChoice()).toBeNull();
    expect(localStorage.getItem(THEME_CHOICE_STORAGE_KEY)).toBeNull();
  });

  it('is none for a look the console no longer carries', () => {
    localStorage.setItem(THEME_CHOICE_STORAGE_KEY, 'retired');
    expect(loadThemeChoice()).toBeNull();
  });

  it('holds for the visit when the browser refuses its storage', () => {
    expect(() => saveThemeChoice('swarm', REFUSING)).not.toThrow();
    expect(() => saveThemeChoice(null, REFUSING)).not.toThrow();
    expect(loadThemeChoice(REFUSING)).toBeNull();
  });
});

describe("the host's look as this browser last saw it", () => {
  it('is Default until a host named one, and read back once one did', () => {
    expect(loadHostLook()).toBe(DEFAULT_ADMIN_THEME);
    saveHostLook('web3privacy');
    expect(loadHostLook()).toBe('web3privacy');
    expect(localStorage.getItem(HOST_THEME_STORAGE_KEY)).toBe('web3privacy');
  });

  it('is Default for a look the console no longer carries, and when the browser refuses its storage', () => {
    localStorage.setItem(HOST_THEME_STORAGE_KEY, 'retired');
    expect(loadHostLook()).toBe(DEFAULT_ADMIN_THEME);
    expect(() => saveHostLook('swarm', REFUSING)).not.toThrow();
    expect(loadHostLook(REFUSING)).toBe(DEFAULT_ADMIN_THEME);
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
  it('offers Swarm and Web3Privacy only, with the host look checked while this browser has no pick', async () => {
    hostSays('swarm');
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );
    await waitFor(() => expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary));
    const menu = openUserMenu();

    expect(within(menu).getByText('Theme')).toBeInTheDocument();
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['Swarm', 'Web3Privacy']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
  });

  it("checks this browser's own pick over the host's look", async () => {
    hostSays('swarm');
    saveThemeChoice('web3privacy');
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );
    const menu = openUserMenu();

    expect(await within(menu).findByRole('menuitemradio', { name: 'Web3Privacy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitemradio', { name: 'Swarm' })).toHaveAttribute('aria-checked', 'false');
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

describe('the look the console wears', () => {
  const renderShell = () =>
    renderWithProviders(
      <AppShell>
        <WornAccent />
      </AppShell>,
    );

  it("is the host's default when this browser picked none, and the browser remembers it", async () => {
    hostSays('web3privacy');
    renderShell();

    await waitFor(() =>
      expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.web3privacy.colors.primary),
    );
    expect(loadHostLook()).toBe('web3privacy');
  });

  it("is this browser's own pick, whatever the host's default", async () => {
    const fetchMock = hostSays('swarm');
    saveThemeChoice('web3privacy');
    renderShell();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(loadHostLook()).toBe('swarm'));
    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.web3privacy.colors.primary);
  });

  it('keeps a pick made while the host was still answering', async () => {
    let answer: (response: Response) => void = () => undefined;
    hostAnswers(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'ada' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Swarm' }));

    await act(async () => answer(jsonOk(hostConfig('web3privacy'))));

    await waitFor(() => expect(loadHostLook()).toBe('web3privacy'));
    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
  });

  it("is the host default this browser last saw while the host's answer is on its way", () => {
    saveHostLook('swarm');
    hostAnswers(() => new Promise<Response>(() => undefined));
    renderShell();

    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
  });

  it('keeps the host default this browser last saw when the config cannot be read', async () => {
    saveHostLook('swarm');
    const fetchMock = hostAnswers(() => jsonError(500, { error: 'internal_error' }));
    renderShell();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
    expect(loadHostLook()).toBe('swarm');
  });

  it('is Swarm when the config cannot be reached and this browser never saw a host default', async () => {
    const fetchMock = hostAnswers(() => Promise.reject(new TypeError('Failed to fetch')));
    renderShell();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
  });

  it('keeps the remembered host default when the host names a look this console does not carry', async () => {
    saveHostLook('swarm');
    const fetchMock = hostSays('retired');
    renderShell();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('accent')).toHaveTextContent(THEME_TOKENS.swarm.colors.primary);
  });
});
