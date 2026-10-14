import type { AppConfig, ProviderConfig } from '../config.js';
import { createSmtpEmailProvider, type SmtpTransportFactory } from './smtp.js';
import { createUsdaNutritionProvider } from './usda.js';
import { createOpenAiRecipeProvider } from './openaiRecipes.js';
import { createOpenAiDinnerReconstructionProvider } from './openaiDinnerReconstruction.js';
import { createGeminiDinnerReconstructionProvider } from './geminiDinnerReconstruction.js';
import { createGeminiRecipeProvider } from './geminiRecipes.js';
import {
  createUnavailableEmailProvider,
  createUnavailableNutritionProvider,
  createUnavailableRecipeProvider,
  createUnavailableDinnerReconstructionProvider,
  type ProviderUnavailableReason,
} from './unavailable.js';
import type { ProviderBundle } from './types.js';

export interface ProviderFactoryOptions {
  fetch?: typeof globalThis.fetch;
  createTransport?: SmtpTransportFactory;
}

const reasonFor = (configured: string | undefined): ProviderUnavailableReason => (
  configured === undefined ? 'missing_configuration' : 'adapter_not_enabled'
);

type ConfiguredSmtpProviderConfig = ProviderConfig & { smtpHost: string; emailFrom: string };

const isSmtpAuthConfigured = ({ smtpUser, smtpPass }: ProviderConfig): boolean => (
  (smtpUser === undefined) === (smtpPass === undefined)
);

const isSmtpConfigured = (providers: ProviderConfig): providers is ConfiguredSmtpProviderConfig => (
  providers.smtpHost !== undefined
  && providers.emailFrom !== undefined
  && isSmtpAuthConfigured(providers)
);

const emailUnavailableReason = (providers: ProviderConfig): ProviderUnavailableReason => (
  providers.smtpHost === undefined || !isSmtpAuthConfigured(providers)
    ? 'missing_configuration'
    : 'adapter_not_enabled'
);

export const createProviders = (
  config: Pick<AppConfig, 'providers'>,
  options: ProviderFactoryOptions = {},
): ProviderBundle => {
  const providers: ProviderConfig = config.providers;

  return {
    email: isSmtpConfigured(providers)
      ? createSmtpEmailProvider({
        host: providers.smtpHost,
        port: providers.smtpPort ?? 587,
        secure: (providers.smtpPort ?? 587) === 465,
        user: providers.smtpUser,
        pass: providers.smtpPass,
        from: providers.emailFrom,
        timeoutMs: providers.smtpTimeoutMs,
        createTransport: options.createTransport,
      })
      : createUnavailableEmailProvider(emailUnavailableReason(providers)),
    nutrition: providers.usdaApiKey !== undefined
      ? createUsdaNutritionProvider({ apiKey: providers.usdaApiKey, fetch: options.fetch, timeoutMs: providers.usdaTimeoutMs })
      : createUnavailableNutritionProvider(reasonFor(providers.usdaApiKey)),
    recipes: providers.recipeProvider === 'gemini'
      ? providers.geminiApiKey !== undefined
        ? createGeminiRecipeProvider({
          apiKey: providers.geminiApiKey,
          model: providers.geminiModel ?? 'gemini-3.5-flash-lite',
          fetch: options.fetch,
        })
        : createUnavailableRecipeProvider(reasonFor(providers.geminiApiKey))
      : providers.openAiApiKey !== undefined
        ? createOpenAiRecipeProvider({
          apiKey: providers.openAiApiKey,
          model: providers.openAiModel ?? 'gpt-5.5',
          fetch: options.fetch,
          timeoutMs: providers.openAiTimeoutMs,
        })
        : createUnavailableRecipeProvider(reasonFor(providers.openAiApiKey)),
    dinnerReconstruction: providers.recipeProvider === 'gemini'
      ? providers.geminiApiKey !== undefined
        ? createGeminiDinnerReconstructionProvider({
          apiKey: providers.geminiApiKey,
          model: providers.geminiModel ?? 'gemini-3.5-flash-lite',
          fetch: options.fetch,
        })
        : createUnavailableDinnerReconstructionProvider(reasonFor(providers.geminiApiKey))
      : providers.openAiApiKey !== undefined
        ? createOpenAiDinnerReconstructionProvider({
          apiKey: providers.openAiApiKey,
          model: providers.openAiModel ?? 'gpt-5.5',
          fetch: options.fetch,
          timeoutMs: providers.openAiTimeoutMs,
        })
        : createUnavailableDinnerReconstructionProvider(reasonFor(providers.openAiApiKey)),
  };
};
