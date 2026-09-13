export type ProviderName = 'email' | 'nutrition' | 'recipes';

export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable' as const;

  constructor(
    readonly provider: ProviderName,
    readonly reason: 'missing_configuration' | 'adapter_not_enabled',
  ) {
    super(`${provider} provider is unavailable`);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderRequestError extends Error {
  readonly code = 'provider_error' as const;

  constructor(
    readonly provider: ProviderName,
    message = `${provider} provider request failed`,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailProvider {
  send: (message: EmailMessage) => Promise<{ messageId: string }>;
}

export interface NutritionLookup {
  query: string;
  quantityGrams?: number;
}

export interface NutritionEstimate {
  source: 'usda';
  calories: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  fatGrams: number | null;
  matchedFood: string;
  isComplete: boolean;
  missingNutrients: string[];
}

export interface NutritionProvider {
  lookup: (lookup: NutritionLookup) => Promise<NutritionEstimate>;
}

export interface RecipeGenerationRequest {
  ingredients: string[];
  constraints: string[];
}

export interface GeneratedRecipeDraft {
  title: string;
  description: string;
  ingredients: Array<{ name: string; amount: string }>;
  steps: string[];
}

export interface RecipeGenerationProvider {
  generate: (request: RecipeGenerationRequest) => Promise<GeneratedRecipeDraft>;
}

export interface ProviderBundle {
  email: EmailProvider;
  nutrition: NutritionProvider;
  recipes: RecipeGenerationProvider;
}
