import type { AppConfig, ProviderConfig } from '../config.js';
import { createResendEmailProvider } from './resend.js';
import { createUsdaNutritionProvider } from './usda.js';
import { createOpenAiRecipeProvider } from './openaiRecipes.js';
import {
  createUnavailableEmailProvider,
  createUnavailableNutritionProvider,
  createUnavailableRecipeProvider,
  type ProviderUnavailableReason,
} from './unavailable.js';
import type { ProviderBundle } from './types.js';

export interface ProviderFactoryOptions {
  fetch?: typeof globalThis.fetch;
}

const reasonFor = (configured: string | undefined): ProviderUnavailableReason => (
  configured === undefined ? 'missing_configuration' : 'adapter_not_enabled'
);

export const createProviders = (
  config: Pick<AppConfig, 'providers'>,
  options: ProviderFactoryOptions = {},
): ProviderBundle => {
  const providers: ProviderConfig = config.providers;

  return {
    email: providers.resendApiKey !== undefined && providers.resendFrom !== undefined
      ? createResendEmailProvider({
        apiKey: providers.resendApiKey,
        from: providers.resendFrom,
        fetch: options.fetch,
        timeoutMs: providers.resendTimeoutMs,
      })
      : createUnavailableEmailProvider(reasonFor(providers.resendApiKey)),
    nutrition: providers.usdaApiKey !== undefined
      ? createUsdaNutritionProvider({ apiKey: providers.usdaApiKey, fetch: options.fetch, timeoutMs: providers.usdaTimeoutMs })
      : createUnavailableNutritionProvider(reasonFor(providers.usdaApiKey)),
    recipes: providers.openAiApiKey !== undefined
      ? createOpenAiRecipeProvider({
        apiKey: providers.openAiApiKey,
        model: providers.openAiModel ?? 'gpt-5.5',
        fetch: options.fetch,
        timeoutMs: providers.openAiTimeoutMs,
      })
      : createUnavailableRecipeProvider(reasonFor(providers.openAiApiKey)),
  };
};
