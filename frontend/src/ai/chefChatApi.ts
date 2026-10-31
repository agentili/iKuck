import type { ChefChatRequest, ChefChatResponse } from '@ikuck/shared/contracts';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';

export interface ChefChatConsentStatus {
  consent: {
    enabled: boolean;
    updatedAt: string;
    chatProvider?: 'openai' | 'gemini';
    chatPolicyVersion?: 'chef-chat-v1';
  };
  selectedProvider: 'openai' | 'gemini';
}

export const fetchChefChatConsentStatus = async (request: ApiRequest = apiRequest): Promise<ChefChatConsentStatus> => {
  const response = await request<unknown>('/v1/ai-recipes/consent');
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  const candidate = response as { consent?: unknown; selectedProvider?: unknown };
  const consent = candidate.consent;
  if (typeof consent !== 'object' || consent === null || Array.isArray(consent)) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  const candidateConsent = consent as {
    enabled?: unknown;
    updatedAt?: unknown;
    chatProvider?: unknown;
    chatPolicyVersion?: unknown;
  };
  if (
    typeof candidateConsent.enabled !== 'boolean' ||
    typeof candidateConsent.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidateConsent.updatedAt)) ||
    (candidateConsent.chatProvider !== undefined &&
      candidateConsent.chatProvider !== 'openai' &&
      candidateConsent.chatProvider !== 'gemini') ||
    (candidateConsent.chatPolicyVersion !== undefined && candidateConsent.chatPolicyVersion !== 'chef-chat-v1') ||
    (candidate.selectedProvider !== 'openai' && candidate.selectedProvider !== 'gemini')
  ) {
    throw new ApiClientError(502, 'ai_consent_status_invalid', 'AI consent status is invalid');
  }
  return {
    consent: {
      enabled: candidateConsent.enabled,
      updatedAt: candidateConsent.updatedAt,
      ...(candidateConsent.chatProvider === undefined ? {} : { chatProvider: candidateConsent.chatProvider as 'openai' | 'gemini' }),
      ...(candidateConsent.chatPolicyVersion === undefined ? {} : { chatPolicyVersion: candidateConsent.chatPolicyVersion as 'chef-chat-v1' }),
    },
    selectedProvider: candidate.selectedProvider,
  };
};

export const sendChefChatMessage = async (
  input: ChefChatRequest,
  csrfToken: string,
  request: ApiRequest = apiRequest
): Promise<ChefChatResponse> => {
  const response = await request<ChefChatResponse>('/v1/chef-chat', {
    method: 'POST',
    body: input,
    csrfToken,
  });
  if (typeof response !== 'object' || response === null || !('reply' in response)) {
    throw new ApiClientError(502, 'chef_chat_response_invalid', 'Chef chat response is invalid');
  }
  return response;
};

export const errorMessage = (error: unknown): string => {
  const code = error instanceof ApiClientError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === 'ai_consent_required') return 'Il consenso per la chat AI è richiesto. Autorizzalo nella sezione Ricette AI.';
  if (code === 'ai_chat_rate_limited') return 'Hai raggiunto il limite per la chat AI. Riprova più tardi.';
  if (code === 'provider_timeout') return 'La chat AI ha superato il tempo limite. Riprova.';
  if (code === 'provider_unavailable') return 'Il servizio della chat AI non è momentaneamente disponibile.';
  if (code === 'network_error') return 'Servizio non raggiungibile: la chat AI funziona solo online.';
  return 'Non è stato possibile inviare il messaggio. Riprova.';
};