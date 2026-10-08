import { formatBaseUnits, parseBaseUnits } from '@streaming-monorepo/web2-admin-common';

/**
 * Amounts as the funding API carries them: integer strings in base units, wei for xDAI and PLUR for xBZZ, converted
 * by the contract's own `parseBaseUnits` and `formatBaseUnits`, which use BigInt alone. What the page adds is how it
 * shows a value that is not one, and why a typed amount cannot be read.
 */

/** An amount in base units as a decimal, exact and without trailing zeros, or an em dash for what is not one. */
export function formatUnits(value: string, decimals: number): string {
  try {
    return formatBaseUnits(value, decimals);
  } catch {
    return '—';
  }
}

const BASE_UNITS = /^\d+$/;

/**
 * An amount in base units for a narrow column: rounded half up to `places` decimals, every digit from BigInt, such as
 * 0.110 or 11.451. A balance above zero that rounds to nothing is `<0.001` rather than a zero it is not, and what is
 * not an amount in base units is an em dash. `formatUnits` gives the exact amount, for a tooltip beside it.
 */
export function formatShort(value: string | null, decimals: number, places = 3): string {
  if (value === null || !BASE_UNITS.test(value)) return '—';
  const units = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const step = 10n ** BigInt(places);
  const rounded = (units * step + scale / 2n) / scale;
  if (rounded === 0n && units > 0n) return `<${(1 / 10 ** places).toFixed(places)}`;
  if (places === 0) return rounded.toString();
  return `${rounded / step}.${(rounded % step).toString().padStart(places, '0')}`;
}

export type ReadAmount = { kind: 'empty' } | { kind: 'ok'; value: string } | { kind: 'invalid'; problem: string };

const DECIMAL = /^\d*(?:\.(\d*))?$/;

/**
 * Whether an amount field may hold `typed`, checked as the operator types or pastes: digits and at most one dot, as a
 * number field takes them, so any other character never reaches the field. What the characters alone cannot settle,
 * a dot on its own or too many decimals, `readAmount` still says.
 */
export function acceptsAmountTyping(typed: string): boolean {
  return DECIMAL.test(typed);
}

/** What the operator typed, in base units. An empty field is nothing to send, which is not an error. */
export function readAmount(typed: string, decimals: number): ReadAmount {
  const text = typed.trim();
  if (text === '') return { kind: 'empty' };
  const value = parseBaseUnits(text, decimals);
  if (value !== null) return { kind: 'ok', value };
  const match = DECIMAL.exec(text);
  if (!match || text === '.') return { kind: 'invalid', problem: 'Digits and one dot only, such as 1.5.' };
  if ((match[1] ?? '').length > decimals) return { kind: 'invalid', problem: `At most ${decimals} decimals.` };
  return { kind: 'invalid', problem: 'That is more than any wallet can hold.' };
}
