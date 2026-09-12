import type { AppConfig, ProviderConfig } from '../config.js';
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
    email: createUnavailableEmailProvider(reasonFor(providers.resendApiKey)),
    nutrition: createUnavailableNutritionProvider(reasonFor(providers.usdaApiKey)),
    recipes: createUnavailableRecipeProvider(reasonFor(providers.openAiApiKey)),
  };
};
