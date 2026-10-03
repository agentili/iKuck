import type { AiConsent, AiRecipeProvider, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';

export interface AiRecipeConsentStatus {
  consent: AiConsent;
  selectedProvider: AiRecipeProvider;
}

export interface AiRecipeGenerationInput {
  ingredients: string[];
  constraints: string[];
  existingRecipes?: Array<{ title: string; ingredients: Array<{ name: string; amount: string }> }>;
}

interface ConsentResponse extends AiRecipeConsentStatus {}

interface RecipesResponse {
  recipes: GeneratedRecipe[];
}

interface GeneratedRecipeResponse {
  recipe: GeneratedRecipe;
}

export const fetchAiConsentStatus = async (request: ApiRequest = apiRequest): Promise<AiRecipeConsentStatus> => {
  const response = await request<unknown>('/v1/ai-recipes/consent');
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  const candidate = response as { consent?: unknown; selectedProvider?: unknown };
  const consent = candidate.consent;
  if (typeof consent !== 'object' || consent === null || Array.isArray(consent)) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  const candidateConsent = consent as { enabled?: unknown; updatedAt?: unknown; homeProvider?: unknown; dinnerProvider?: unknown };
  const hasValidHomeProvider = candidateConsent.homeProvider === undefined
    || candidateConsent.homeProvider === 'openai'
    || candidateConsent.homeProvider === 'gemini';
  const hasValidDinnerProvider = candidateConsent.dinnerProvider === undefined
    || candidateConsent.dinnerProvider === 'openai'
    || candidateConsent.dinnerProvider === 'gemini';
  if (typeof candidateConsent.enabled !== 'boolean'
    || typeof candidateConsent.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(candidateConsent.updatedAt))
    || !hasValidHomeProvider
    || !hasValidDinnerProvider
    || (candidate.selectedProvider !== 'openai' && candidate.selectedProvider !== 'gemini')) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  return {
    consent: {
      enabled: candidateConsent.enabled,
      updatedAt: candidateConsent.updatedAt,
      ...(candidateConsent.homeProvider === undefined
        ? {}
        : { homeProvider: candidateConsent.homeProvider as AiRecipeProvider }),
      ...(candidateConsent.dinnerProvider === undefined
        ? {}
        : { dinnerProvider: candidateConsent.dinnerProvider as AiRecipeProvider }),
    },
    selectedProvider: candidate.selectedProvider,
  };
};

export const fetchAiConsent = async (request: ApiRequest = apiRequest): Promise<AiConsent> => {
  const response = await fetchAiConsentStatus(request);
  return response.consent;
};

export const updateAiConsent = async (
  enabled: boolean,
  csrfToken: string,
  expectedRevision?: string,
  request: ApiRequest = apiRequest,
  homeProvider?: AiRecipeProvider,
): Promise<AiConsent> => {
  const response = await request<ConsentResponse>('/v1/ai-recipes/consent', {
    method: 'PUT',
    body: {
      enabled,
      ...(enabled && homeProvider !== undefined ? { homeProvider } : {}),
      ...(enabled && expectedRevision !== undefined ? { expectedRevision } : {}),
    },
    csrfToken,
  });
  return response.consent;
};

export const updateDinnerAiConsent = async (
  dinnerProvider: AiRecipeProvider | null,
  csrfToken: string,
  expectedRevision?: string,
  request: ApiRequest = apiRequest,
): Promise<AiRecipeConsentStatus> => {
  const response = await request<ConsentResponse>('/v1/ai-recipes/consent', {
    method: 'PUT',
    body: {
      dinnerProvider,
      ...(dinnerProvider !== null && expectedRevision !== undefined ? { expectedRevision } : {}),
    },
    csrfToken,
  });
  return { consent: response.consent, selectedProvider: response.selectedProvider };
};

export const fetchAiRecipes = async (request: ApiRequest = apiRequest): Promise<GeneratedRecipe[]> => {
  const response = await request<RecipesResponse>('/v1/ai-recipes');
  return response.recipes;
};

export const generateAiRecipe = async (
  input: AiRecipeGenerationInput,
  dietProfile: DietProfilePayload,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<GeneratedRecipe> => {
  const profilePayload: DietProfilePayload = {
    diet: dietProfile.diet,
    excludedAllergens: dietProfile.excludedAllergens,
    nutrition: dietProfile.nutrition,
  };
  const response = await request<GeneratedRecipeResponse>('/v1/ai-recipes', {
    method: 'POST',
    body: { ...input, dietProfile: profilePayload },
    csrfToken,
  });
  return response.recipe;
};

export const saveAiRecipe = async (
  recipe: GeneratedRecipe,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<GeneratedRecipe> => {
  const response = await request<GeneratedRecipeResponse>('/v1/ai-recipes/save', {
    method: 'POST',
    body: { recipe },
    csrfToken,
  });
  return response.recipe;
};

export const deleteAiRecipe = async (
  recipeId: string,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<void> => {
  await request<void>(`/v1/ai-recipes/${encodeURIComponent(recipeId)}`, {
    method: 'DELETE',
    csrfToken,
  });
};
