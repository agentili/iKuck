import type { FastifyPluginAsync } from 'fastify';
import type { AiRecipeProvider } from '@ikuck/shared/contracts';
import { parseChefChatRequest } from '../ai/chefChatValidation.js';
import type { QuotaReservation } from '../ai/chefChatQuota.js';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import type { ChefChatOperation } from '../providers/chefChat.js';
import { ProviderTimeoutError } from '../providers/types.js';
import { AiConsentRequiredError, type SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export type ChefChatDependencies = {
  authService: AuthService;
  appOrigin: string;
  repository?: SyncRepository;
  recipeProvider?: AiRecipeProvider;
  provider?: { startChat: (request: NonNullable<ReturnType<typeof parseChefChatRequest>> & { signal?: AbortSignal }) => ChefChatOperation };
  quota?: { reserve: (userId: string) => Promise<QuotaReservation>; dispatch: (id: string, token: string) => Promise<boolean>; cancel: (userId: string, id: string, token: string) => Promise<boolean> };
  store?: { settle: (id: string, token: string) => Promise<boolean> };
};

export const registerChefChatRoutes = (dependencies: ChefChatDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/chef-chat', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    ensureSameOrigin(request, dependencies.appOrigin);
    const { session } = await requireVerifiedSession(request, dependencies.authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsed = parseChefChatRequest(request.body);
    if (!parsed) throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
    const { repository, provider, quota, store, recipeProvider } = dependencies;
    if (!repository || !provider || !quota || !store || !recipeProvider) throw new AuthServiceError('provider_unavailable', 503, 'AI chat is unavailable');
    const reservation = await quota.reserve(session.userId);
    if (reservation.kind === 'unavailable') throw new AuthServiceError('provider_unavailable', 503, 'AI chat is unavailable');
    if (reservation.kind === 'limited') {
      if (reservation.retryAfterSeconds !== undefined) reply.header('retry-after', String(reservation.retryAfterSeconds));
      throw new AuthServiceError('ai_chat_rate_limited', 429, 'AI chat limit reached');
    }
    const { operationId, token } = reservation;
    let dispatchAttempted = false;
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', onClose);
    try {
      const operation = await repository.withAiConsentDispatch(session.userId, { kind: 'chat', provider: recipeProvider, policyVersion: 'chef-chat-v1' }, async () => {
        if (controller.signal.aborted) throw new AuthServiceError('provider_unavailable', 503, 'AI chat is unavailable');
        dispatchAttempted = true;
        if (!await quota.dispatch(operationId, token) || controller.signal.aborted) throw new AuthServiceError('provider_unavailable', 503, 'AI chat is unavailable');
        const operation = provider.startChat({ ...parsed, signal: controller.signal });
        const successful = operation.response.then(() => true, () => false);
        void Promise.all([successful, operation.settled]).then(async ([ok]) => {
          if (ok) await store.settle(operationId, token);
        }).catch(() => undefined);
        return operation;
      }, controller.signal);
      return { reply: await operation.response };
    } catch (error) {
      if (!dispatchAttempted) await quota.cancel(session.userId, operationId, token).catch(() => false);
      if (error instanceof AiConsentRequiredError) throw new AuthServiceError('ai_consent_required', 403, 'AI chat consent is required');
      if (error instanceof ProviderTimeoutError) throw new AuthServiceError('provider_timeout', 504, 'AI chat timed out');
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError('provider_unavailable', 503, 'AI chat is unavailable');
    } finally {
      reply.raw.off('close', onClose);
    }
  });
};
