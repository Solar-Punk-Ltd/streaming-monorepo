import { XBZZ_DECIMALS, XDAI_DECIMALS } from '@streaming-monorepo/web2-admin-common';
import { describe, expect, it } from 'vitest';

import { acceptsAmountTyping, formatShort, formatUnits, readAmount, roundUpUnits } from '../components/funding/amounts';

describe('an amount in base units, as the Funding page shows it', () => {
  it('writes wei as xDAI and PLUR as xBZZ exactly, with no trailing zeros', () => {
    expect(formatUnits('1500000000000000000', XDAI_DECIMALS)).toBe('1.5');
    expect(formatUnits('1', XDAI_DECIMALS)).toBe('0.000000000000000001');
    expect(formatUnits('0', XDAI_DECIMALS)).toBe('0');
    expect(formatUnits('125000000000000000', XBZZ_DECIMALS)).toBe('12.5');
    expect(formatUnits('10000000000000000', XBZZ_DECIMALS)).toBe('1');
    expect(formatUnits('1', XBZZ_DECIMALS)).toBe('0.0000000000000001');
  });

  it('keeps every digit of a large balance, which a floating point number would round', () => {
    expect(formatUnits('123456789012345678901234567', XDAI_DECIMALS)).toBe('123456789.012345678901234567');
    expect(formatUnits('900719925474099312345678', XBZZ_DECIMALS)).toBe('90071992.5474099312345678');
  });

  it('shows a dash for a value that is not an amount in base units', () => {
    for (const bad of ['', '-1', '1.5', '0x10', 'abc', ' 1']) {
      expect(formatUnits(bad, XDAI_DECIMALS), bad).toBe('—');
    }
  });
});

describe('an amount in base units, short, as the node tables show it', () => {
  it('rounds half up to three decimals and keeps the zeros, from BigInt alone', () => {
    expect(formatShort('109999993971072141', XDAI_DECIMALS)).toBe('0.110');
    expect(formatShort('99999992745065433', XDAI_DECIMALS)).toBe('0.100');
    expect(formatShort('114514240000000000', XBZZ_DECIMALS)).toBe('11.451');
    expect(formatShort('296113920000000000', XBZZ_DECIMALS)).toBe('29.611');
    expect(formatShort('1000000000000000000', XDAI_DECIMALS)).toBe('1.000');
    expect(formatShort('1500000000000000', XDAI_DECIMALS)).toBe('0.002');
    expect(formatShort('1499999999999999', XDAI_DECIMALS)).toBe('0.001');
    expect(formatShort('999500000000000000', XDAI_DECIMALS)).toBe('1.000');
    expect(formatShort('123456789012345678901234567', XDAI_DECIMALS)).toBe('123456789.012');
  });

  it('says less than 0.001 for a balance above zero that would round to nothing, and 0.000 for none', () => {
    expect(formatShort('1', XDAI_DECIMALS)).toBe('<0.001');
    expect(formatShort('499999999999999', XDAI_DECIMALS)).toBe('<0.001');
    expect(formatShort('0', XDAI_DECIMALS)).toBe('0.000');
  });

  it('shows a dash for nothing read and for what is not an amount in base units', () => {
    for (const bad of [null, '', '-1', '1.5', '0x10', 'abc', ' 1']) {
      expect(formatShort(bad, XDAI_DECIMALS), String(bad)).toBe('—');
    }
  });
});

describe('an amount rounded up, as a shortfall is', () => {
  it('rounds up to three decimals and stays in base units, so it is never less than the amount', () => {
    expect(roundUpUnits(2_183_852_646_400_000n, XBZZ_DECIMALS)).toBe(2_190_000_000_000_000n);
    expect(roundUpUnits(2_190_000_000_000_000n, XBZZ_DECIMALS)).toBe(2_190_000_000_000_000n);
    expect(roundUpUnits(1n, XBZZ_DECIMALS)).toBe(10_000_000_000_000n);
    expect(roundUpUnits(0n, XBZZ_DECIMALS)).toBe(0n);
    expect(formatShort(roundUpUnits(2_183_852_646_400_000n, XBZZ_DECIMALS).toString(), XBZZ_DECIMALS)).toBe('0.219');
  });

  it('keeps an amount that has no more decimals than it rounds to', () => {
    expect(roundUpUnits(123n, 2, 3)).toBe(123n);
    expect(roundUpUnits(123n, 3, 3)).toBe(123n);
  });
});

describe('what an amount field lets in as it is typed', () => {
  it('takes digits and at most one dot, at every step of typing a number', () => {
    for (const typed of ['', '1', '12', '1.', '1.5', '.', '.5', '0.01', '007', '123456789.123456789']) {
      expect(acceptsAmountTyping(typed), typed).toBe(true);
    }
  });

  it('refuses any other character, a second dot, and a space', () => {
    for (const typed of ['0.01a', '12.3.3', '1,5', '-1', '+1', '1e3', '0x10', ' 1', '1 ', '1 000', 'Infinity', '١']) {
      expect(acceptsAmountTyping(typed), typed).toBe(false);
    }
  });
});

describe('an amount the operator types', () => {
  it('reads xDAI into wei and xBZZ into PLUR exactly', () => {
    expect(readAmount('1.5', XDAI_DECIMALS)).toEqual({ kind: 'ok', value: '1500000000000000000' });
    expect(readAmount('0.000000000000000001', XDAI_DECIMALS)).toEqual({ kind: 'ok', value: '1' });
    expect(readAmount(' 12.5 ', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '125000000000000000' });
    expect(readAmount('.25', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '2500000000000000' });
    expect(readAmount('3.', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '30000000000000000' });
    expect(readAmount('007', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '70000000000000000' });
    expect(readAmount('0', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '0' });
  });

  it('reads an empty field as nothing to send', () => {
    expect(readAmount('', XDAI_DECIMALS)).toEqual({ kind: 'empty' });
    expect(readAmount('   ', XDAI_DECIMALS)).toEqual({ kind: 'empty' });
  });

  it('refuses what is not a plain decimal number', () => {
    for (const bad of ['-1', '+1', '1e3', '1,5', '0x10', '.', '1.2.3', 'abc', '1 000', 'Infinity']) {
      expect(readAmount(bad, XDAI_DECIMALS), bad).toEqual({
        kind: 'invalid',
        problem: 'Digits and one dot only, such as 1.5.',
      });
    }
  });

  it('refuses more decimals than the token has', () => {
    expect(readAmount('0.00000000000000001', XBZZ_DECIMALS)).toEqual({
      kind: 'invalid',
      problem: 'At most 16 decimals.',
    });
    expect(readAmount('0.0000000000000000001', XDAI_DECIMALS)).toEqual({
      kind: 'invalid',
      problem: 'At most 18 decimals.',
    });
    expect(readAmount('0.1000000000000000', XBZZ_DECIMALS)).toEqual({ kind: 'ok', value: '1000000000000000' });
  });

  it('gives back the amount it read, both ways', () => {
    for (const typed of ['1', '0.1', '12.3456789', '1000000', '0.000000000000000001', '98765.4321']) {
      const read = readAmount(typed, XDAI_DECIMALS);
      expect(read.kind).toBe('ok');
      expect(formatUnits(read.kind === 'ok' ? read.value : '', XDAI_DECIMALS)).toBe(typed);
    }
    for (const wei of ['1', '10', '999999999999999999', '1000000000000000001']) {
      const read = readAmount(formatUnits(wei, XDAI_DECIMALS), XDAI_DECIMALS);
      expect(read).toEqual({ kind: 'ok', value: wei });
    }
  });

  it('adds 0.1 and 0.2 xDAI to exactly 0.3, which floating point does not', () => {
    const tenth = readAmount('0.1', XDAI_DECIMALS);
    const fifth = readAmount('0.2', XDAI_DECIMALS);
    expect(tenth.kind === 'ok' && fifth.kind === 'ok').toBe(true);
    const sum = tenth.kind === 'ok' && fifth.kind === 'ok' ? BigInt(tenth.value) + BigInt(fifth.value) : 0n;
    expect(formatUnits(sum.toString(), XDAI_DECIMALS)).toBe('0.3');
  });
});
