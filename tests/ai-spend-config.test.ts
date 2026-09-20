import { describe, expect, it } from 'vitest';
import { resolveAiSpendConfig } from '../server/ai-spend-config.js';

describe('explicit local AI spending guard configuration', () => {
  it('keeps the existing $6 cap enabled by default and preserves an explicit zero cap', () => {
    expect(resolveAiSpendConfig({}, {})).toEqual({ spendLimitUsd: 6, spendCapEnabled: true });
    expect(resolveAiSpendConfig({ spendLimitUsd: 0 }, {})).toEqual({ spendLimitUsd: 0, spendCapEnabled: true });
  });
  it('requires the explicit disabled mode while retaining the configured threshold', () => {
    expect(resolveAiSpendConfig({}, { RIPPLE_AI_SPEND_LIMIT_USD: '8', RIPPLE_AI_SPEND_CAP: 'disabled' })).toEqual({ spendLimitUsd: 8, spendCapEnabled: false });
    for (const mode of ['false', 'off', 'invalid', '']) expect(resolveAiSpendConfig({}, { RIPPLE_AI_SPEND_CAP: mode }).spendCapEnabled).toBe(true);
  });
  it('uses explicit caller options before environment settings', () => {
    expect(resolveAiSpendConfig({ spendLimitUsd: 2, spendCapEnabled: true }, { RIPPLE_AI_SPEND_LIMIT_USD: '8', RIPPLE_AI_SPEND_CAP: 'disabled' })).toEqual({ spendLimitUsd: 2, spendCapEnabled: true });
    expect(resolveAiSpendConfig({ spendCapEnabled: false }, {})).toEqual({ spendLimitUsd: 6, spendCapEnabled: false });
  });
  it('does not disable the guard for a malformed numeric limit', () => {
    for (const value of ['not-a-number', '-1', 'Infinity']) expect(resolveAiSpendConfig({}, { RIPPLE_AI_SPEND_LIMIT_USD: value })).toEqual({ spendLimitUsd: 6, spendCapEnabled: true });
  });
});
