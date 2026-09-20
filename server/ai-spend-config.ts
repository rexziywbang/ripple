export type AiSpendOptions = { spendLimitUsd?: number; spendCapEnabled?: boolean };

/** Disabling the local guard never disables usage accounting or request limits. */
export function resolveAiSpendConfig(config: AiSpendOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const configuredLimit = config.spendLimitUsd ?? Number(env.RIPPLE_AI_SPEND_LIMIT_USD ?? 6);
  const spendLimitUsd = Number.isFinite(configuredLimit) && configuredLimit >= 0 ? configuredLimit : 6;
  const spendCapEnabled = config.spendCapEnabled ?? env.RIPPLE_AI_SPEND_CAP?.trim().toLowerCase() !== 'disabled';
  return { spendLimitUsd, spendCapEnabled };
}
