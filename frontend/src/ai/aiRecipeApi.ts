import type { AiConsent, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { apiRequest, type ApiRequest } from '../api/apiClient';

export interface AiRecipeGenerationInput {
  ingredients: string[];
  constraints: string[];
}

interface ConsentResponse {
  consent: AiConsent;
}

interface RecipesResponse {
  recipes: GeneratedRecipe[];
}

interface GeneratedRecipeResponse {
  recipe: GeneratedRecipe;
}

export const fetchAiConsent = async (request: ApiRequest = apiRequest): Promise<AiConsent> => {
  const response = await request<ConsentResponse>('/v1/ai-recipes/consent');
  return response.consent;
};

export const updateAiConsent = async (
  enabled: boolean,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<AiConsent> => {
  const response = await request<ConsentResponse>('/v1/ai-recipes/consent', {
    method: 'PUT',
    body: { enabled },
    csrfToken,
  });
  return response.consent;
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
  const response = await request<GeneratedRecipeResponse>('/v1/ai-recipes', {
    method: 'POST',
    body: { ...input, dietProfile },
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
