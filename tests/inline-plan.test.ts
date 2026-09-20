import { describe, expect, it } from 'vitest';
import { parseInlineValue } from '../web/src/InlinePlan';

describe('inline plan value validation', () => {
  it('does not turn an empty numeric draft into zero, even for optional fields', () => {
    for (const kind of ['integer', 'money'] as const) {
      for (const raw of ['', '   ', '\t']) {
        expect(parseInlineValue(raw, { kind, optional: true }).ok).toBe(false);
      }
      expect(parseInlineValue('0', { kind })).toEqual({ ok: true, value: 0 });
    }
  });

  it('converts supported money formats into exact integer cents', () => {
    for (const [raw, cents] of [['0.29', 29], ['1.01', 101], ['.50', 50], ['$ 1,234.56', 123456], ['12', 1200], ['12.3', 1230]] as const) {
      expect(parseInlineValue(raw, { kind: 'money' })).toEqual({ ok: true, value: cents });
    }
  });

  it('rejects incomplete prices, rounding requests, exponents, and negative money', () => {
    for (const raw of ['12.345', '.001', '12.', '.', '$', '1e3', '-1.00', 'NaN', 'Infinity']) {
      expect(parseInlineValue(raw, { kind: 'money' }).ok, raw).toBe(false);
    }
  });

  it('checks money bounds in cents rather than dollars', () => {
    expect(parseInlineValue('10.00', { kind: 'money', min: 1, max: 1000 })).toEqual({ ok: true, value: 1000 });
    expect(parseInlineValue('10.01', { kind: 'money', min: 1, max: 1000 }).ok).toBe(false);
    expect(parseInlineValue('0.00', { kind: 'money', min: 1, max: 1000 }).ok).toBe(false);
    expect(parseInlineValue('99999999999999999999.99', { kind: 'money' }).ok).toBe(false);
  });

  it('accepts integer bounds and rejects fractional or out-of-range headcounts', () => {
    const options = { kind: 'integer' as const, min: 1, max: 100000 };
    expect(parseInlineValue('1', options)).toEqual({ ok: true, value: 1 });
    expect(parseInlineValue('100,000', options)).toEqual({ ok: true, value: 100000 });
    for (const raw of ['0', '100001', '2.5', '-2', '2e2', '9007199254740992']) {
      expect(parseInlineValue(raw, options).ok, raw).toBe(false);
    }
  });

  it('rejects misplaced thousands separators instead of silently changing the number', () => {
    for (const raw of ['1,2', ',123', '123,', '1,,000', '12,34,567']) {
      expect(parseInlineValue(raw, { kind: 'integer' }).ok, raw).toBe(false);
    }
    for (const raw of ['$1,2.34', '1,234.5,6', '$,12.00']) {
      expect(parseInlineValue(raw, { kind: 'money' }).ok, raw).toBe(false);
    }
  });

  it('validates calendar dates including Gregorian leap-year rules', () => {
    for (const raw of ['2024-02-29', '2000-02-29', '2026-12-31']) {
      expect(parseInlineValue(raw, { kind: 'date' })).toEqual({ ok: true, value: raw });
    }
    for (const raw of ['2025-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-2-01', '12/11/2026']) {
      expect(parseInlineValue(raw, { kind: 'date' }).ok, raw).toBe(false);
    }
  });

  it('accepts complete 24-hour times and rejects impossible values', () => {
    expect(parseInlineValue('00:00', { kind: 'time' })).toEqual({ ok: true, value: '00:00' });
    expect(parseInlineValue('23:59', { kind: 'time' })).toEqual({ ok: true, value: '23:59' });
    for (const raw of ['24:00', '12:60', '6:30', '18:30:00', '6 PM']) {
      expect(parseInlineValue(raw, { kind: 'time' }).ok, raw).toBe(false);
    }
  });

  it('checks time-zone identifiers rather than accepting arbitrary text', () => {
    for (const raw of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      expect(parseInlineValue(raw, { kind: 'timezone' })).toEqual({ ok: true, value: raw });
    }
    for (const raw of ['', 'America/Not_A_City', 'not a time zone', 'GMT+25']) {
      expect(parseInlineValue(raw, { kind: 'timezone' }).ok, raw).toBe(false);
    }
  });

  it('allows intentionally cleared optional text while keeping required text meaningful', () => {
    expect(parseInlineValue('  ', { optional: true })).toEqual({ ok: true, value: '' });
    expect(parseInlineValue('  ').ok).toBe(false);
    expect(parseInlineValue('  Grand Ballroom  ')).toEqual({ ok: true, value: 'Grand Ballroom' });
    expect(parseInlineValue('x'.repeat(8001)).ok).toBe(false);
  });
});
