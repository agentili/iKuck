import {
  type EmailProvider,
  type NutritionProvider,
  ProviderUnavailableError,
  type RecipeGenerationProvider,
  type DinnerReconstructionProvider,
} from './types.js';

export type ProviderUnavailableReason = 'missing_configuration' | 'adapter_not_enabled';

export const createUnavailableEmailProvider = (reason: ProviderUnavailableReason): EmailProvider => ({
  send: async () => {
    throw new ProviderUnavailableError('email', reason);
  },
});

export const createUnavailableNutritionProvider = (reason: ProviderUnavailableReason): NutritionProvider => ({
  lookup: async () => {
    throw new ProviderUnavailableError('nutrition', reason);
  },
});

export const createUnavailableRecipeProvider = (reason: ProviderUnavailableReason): RecipeGenerationProvider => ({
  generate: async () => {
    throw new ProviderUnavailableError('recipes', reason);
  },
});

export const createUnavailableDinnerReconstructionProvider = (reason: ProviderUnavailableReason): DinnerReconstructionProvider => ({
  reconstruct: async () => {
    throw new ProviderUnavailableError('dinner_reconstruction', reason);
  },
});
