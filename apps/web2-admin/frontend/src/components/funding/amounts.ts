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

export type ReadAmount = { kind: 'empty' } | { kind: 'ok'; value: string } | { kind: 'invalid'; problem: string };

const DECIMAL = /^\d*(?:\.(\d*))?$/;

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
