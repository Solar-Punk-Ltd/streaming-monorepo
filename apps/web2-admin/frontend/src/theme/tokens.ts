import type { AdminThemeName } from './themeNames';

/** A lighter and a darker step of one colour, as MUI uses them for tints and pressed states. */
export interface Shade {
  light: string;
  dark: string;
}

/**
 * Everything a look decides, and nothing else. Every theme fills in every field, so a switch leaves
 * nothing at MUI's default by accident, and `createAdminTheme` is the one place these become a MUI
 * theme. Components never read these: they read the MUI theme (`text.secondary`, `primary.main`).
 */
export interface ThemeTokens {
  /** What the switcher calls it. */
  label: string;
  colors: {
    /** The page behind everything. */
    background: string;
    /** Cards, dialogs, menus and tables. */
    surface: string;
    /** The top bar. */
    bar: string;
    divider: string;
    text: string;
    textSecondary: string;
    textDisabled: string;
    /** The accent: contained buttons, links, focus, the selected tab. */
    primary: string;
    /** The accent under a pointer, and a contained button pressed. */
    primaryHover: string;
    /** Words written on the accent. */
    onPrimary: string;
    error: string;
    warning: string;
    success: string;
    info: string;
  };
  fonts: {
    base: string;
    heading: string;
    /** Addresses, batch ids, keys and amounts that are read character by character. */
    mono: string;
  };
  /** The weight of h1 to h6, or null to keep MUI's own step per heading. */
  headingWeight: number | null;
  /** Corners of cards, fields and buttons, in pixels. */
  radius: number;
  /** A button's label as written, or in capitals. */
  buttonCase: 'none' | 'uppercase';
  /** Surfaces keep their own colour when raised, rather than MUI's dark-mode lightening overlay. */
  flatSurfaces: boolean;
  /**
   * The lighter steps of the accent and the steps of each status colour, or null to let MUI work them
   * out from each colour. MUI's own come from its palette tables rather than from the colour, so a look
   * that has to match MUI exactly writes them out.
   */
  shades: { primaryLight: string; error: Shade; warning: Shade; success: Shade; info: Shade } | null;
}

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export const THEME_TOKENS: Record<AdminThemeName, ThemeTokens> = {
  // MUI's own dark palette, the console's look before there were themes, every step of it written out
  // so the contrast test reads it like the others and a MUI upgrade cannot move it.
  default: {
    label: 'Default',
    colors: {
      background: '#121212',
      surface: '#121212',
      bar: '#212121',
      divider: 'rgba(255, 255, 255, 0.12)',
      text: '#fff',
      textSecondary: 'rgba(255, 255, 255, 0.7)',
      textDisabled: 'rgba(255, 255, 255, 0.5)',
      primary: '#90caf9',
      primaryHover: '#42a5f5',
      onPrimary: 'rgba(0, 0, 0, 0.87)',
      error: '#f44336',
      warning: '#ffa726',
      success: '#66bb6a',
      info: '#29b6f6',
    },
    fonts: {
      base: '"Roboto", "Helvetica", "Arial", sans-serif',
      heading: '"Roboto", "Helvetica", "Arial", sans-serif',
      mono: 'monospace',
    },
    headingWeight: null,
    radius: 4,
    buttonCase: 'uppercase',
    flatSurfaces: false,
    shades: {
      primaryLight: '#e3f2fd',
      error: { light: '#e57373', dark: '#d32f2f' },
      warning: { light: '#ffb74d', dark: '#f57c00' },
      success: { light: '#81c784', dark: '#388e3c' },
      info: { light: '#4fc3f7', dark: '#0288d1' },
    },
  },
  // Swarm Brand v3.0 as the event viewer wears it: near-black surfaces, the orange as a sparing
  // accent with the darkest neutral written on it (white on it measures 2.6:1), Geist throughout.
  swarm: {
    label: 'Swarm',
    colors: {
      background: '#151517',
      surface: '#1b1b1c',
      bar: '#1b1b1c',
      divider: '#333333',
      text: '#fafafa',
      textSecondary: 'rgba(250, 250, 250, 0.72)',
      textDisabled: 'rgba(250, 250, 250, 0.5)',
      primary: '#f47a20',
      primaryHover: '#f79c5a',
      onPrimary: '#151517',
      error: '#ff8a8a',
      warning: '#f28b0a',
      success: '#4ade80',
      info: '#60a5fa',
    },
    fonts: {
      base: `"Geist", ${SYSTEM_SANS}`,
      heading: `"Geist", ${SYSTEM_SANS}`,
      mono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    },
    headingWeight: 700,
    radius: 8,
    buttonCase: 'none',
    flatSurfaces: true,
    shades: null,
  },
  // web3privacy.info's own: a black page, white text, the neon green with its dark green written on
  // it, Archivo for text and Domine headings in the regular weight, calls to action in capitals.
  web3privacy: {
    label: 'Web3Privacy',
    colors: {
      background: '#000000',
      surface: '#0a0a0a',
      bar: '#0a0a0a',
      divider: 'rgba(255, 255, 255, 0.1)',
      text: '#ffffff',
      textSecondary: '#e0e0e0',
      textDisabled: '#808080',
      primary: '#70ff88',
      primaryHover: '#8cff9e',
      onPrimary: '#122014',
      error: '#ff8b80',
      warning: '#f28b0a',
      success: '#70ff88',
      info: '#60a5fa',
    },
    fonts: {
      base: `"Archivo", ${SYSTEM_SANS}`,
      heading: '"Domine", Georgia, serif',
      mono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    },
    headingWeight: 400,
    radius: 8,
    buttonCase: 'uppercase',
    flatSurfaces: true,
    shades: null,
  },
};
