import type { AppConfig, ProviderConfig } from '../config.js';
import { createResendEmailProvider } from './resend.js';
import {
  createUnavailableEmailProvider,
  createUnavailableNutritionProvider,
  createUnavailableRecipeProvider,
  type ProviderUnavailableReason,
} from './unavailable.js';
import type { ProviderBundle } from './types.js';

const reasonFor = (configured: string | undefined): ProviderUnavailableReason => (
  configured === undefined ? 'missing_configuration' : 'adapter_not_enabled'
);

export const createProviders = (
  config: Pick<AppConfig, 'providers'>,
): ProviderBundle => {
  const providers: ProviderConfig = config.providers;

  return {
    email: providers.resendApiKey !== undefined && providers.resendFrom !== undefined
      ? createResendEmailProvider({ apiKey: providers.resendApiKey, from: providers.resendFrom })
      : createUnavailableEmailProvider(reasonFor(providers.resendApiKey)),
    nutrition: createUnavailableNutritionProvider(reasonFor(providers.usdaApiKey)),
    recipes: createUnavailableRecipeProvider(reasonFor(providers.openAiApiKey)),
  };
};
