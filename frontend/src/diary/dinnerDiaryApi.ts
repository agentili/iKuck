import { DIARY_MAX_RECIPES } from '@ikuck/shared/limits';
import { isDiaryRecipeDraft, isDinnerEntry, isSavedRecipe, type DiaryRecipeDraft, type DinnerEntry, type SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';

export interface DinnerReconstructionInput {
  dinnerText: string;
  servings: number | null;
}

export type DiaryRecipeLinkRequest = { recipeId: string; source: 'diary' };

interface ReconstructionResponse { drafts: unknown }
interface ConfirmationResponse { entry: unknown; recipe: unknown }
interface LinkResponse { entry: unknown }

const invalidResponse = (): ApiClientError => new ApiClientError(502, 'invalid_response', 'Dinner diary API returned an invalid response');

export const reconstructDinnerRecipes = async (
  input: DinnerReconstructionInput,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<DiaryRecipeDraft[]> => {
  const response = await request<ReconstructionResponse>('/v1/ai-dinner-reconstruction', {
    method: 'POST', body: input, csrfToken,
  });
  if (!Array.isArray(response?.drafts) || response.drafts.length > DIARY_MAX_RECIPES
    || !response.drafts.every(isDiaryRecipeDraft)
    || new Set(response.drafts.map((draft) => draft.draftId)).size !== response.drafts.length) throw invalidResponse();
  return response.drafts;
};

export const confirmDiaryRecipe = async (
  entryId: string,
  draft: DiaryRecipeDraft,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<{ entry: DinnerEntry; recipe: SavedRecipe }> => {
  if (!isDiaryRecipeDraft(draft)) throw invalidResponse();
  const response = await request<ConfirmationResponse>(`/v1/dinner-entries/${encodeURIComponent(entryId)}/confirm-recipe`, {
    method: 'POST', body: { draft }, csrfToken,
  });
  const entryCandidate = response?.entry;
  const recipeCandidate = response?.recipe;
  if (!isDinnerEntry(entryCandidate) || entryCandidate.id !== entryId || !isSavedRecipe(recipeCandidate)
    || !entryCandidate.recipes.some((link) => link.recipeId === recipeCandidate.id && link.source === 'diary')) throw invalidResponse();
  return { entry: entryCandidate, recipe: recipeCandidate };
};

export const linkDiaryRecipe = async (
  entryId: string,
  link: DiaryRecipeLinkRequest,
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<DinnerEntry> => {
  const response = await request<LinkResponse>(`/v1/dinner-entries/${encodeURIComponent(entryId)}/link-recipe`, {
    method: 'POST', body: link, csrfToken,
  });
  if (!isDinnerEntry(response?.entry) || response.entry.id !== entryId
    || !response.entry.recipes.some((candidate) => candidate.recipeId === link.recipeId && candidate.source === link.source)) throw invalidResponse();
  return response.entry;
};
