import type { DietProfile, PantryLot, EuAllergen, DietType } from '@ikuck/shared/contracts';
import { pantryLotDetailsSchema } from '../pantry/validation.js';
import { isDietProfile } from '../diet/validation.js';

export type DinnerContext = { schemaVersion: 1; retrievedAt: string; pantry: { lots: Array<Pick<PantryLot, 'ingredientId' | 'label' | 'known' | 'quantity' | 'unit' | 'expiresAt'>> }; dietaryConstraints: { status: 'configured'; diet: DietType; excludedAllergens: EuAllergen[] } | { status: 'not_configured' } };
export interface ServiceGrant { keyId: string; digest: string; enabled: boolean; expiresAt: string; scope: 'dinner-context:read' }
export interface DinnerContextSource { readAuthorizedSnapshot(credential: string, options?: { signal: AbortSignal; timeoutMs: number }): Promise<{ grant: ServiceGrant; pantryLots: PantryLot[]; dietProfile: DietProfile | null } | null> }
export interface ServiceRateLimiter { allow(key: string | null, ip: string, options?: { includeIp?: boolean; bucket?: 'credential' | 'presented' }): Promise<boolean> }
export interface S2sDinnerContextDependencies { enabled: boolean; source: DinnerContextSource; clock?: () => Date; rateLimiter?: ServiceRateLimiter; requestTimeoutMs?: number }
export type ServiceResult = { status: number; body: DinnerContext | { code: string }; retryAfter?: number };
export interface S2sRequestBudget { deadlineAt: number; signal: AbortSignal; abort(): void; dispose(): void }
export type S2sRequestPreflight = { budget: S2sRequestBudget } | { result: ServiceResult };
const tokenPattern = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/;
const allergens = new Set<EuAllergen>(['gluten','crustaceans','eggs','fish','peanuts','soybeans','milk','nuts','celery','mustard','sesame','sulphites','lupin','molluscs']);
const diets = new Set<DietType>(['omnivore','vegetarian','pescatarian','vegan']);
const validProfile = (profile: DietProfile): boolean => diets.has(profile.diet) && Array.isArray(profile.excludedAllergens) && new Set(profile.excludedAllergens).size === profile.excludedAllergens.length && profile.excludedAllergens.every((item) => allergens.has(item));
const waitForAbort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const rejectOnAbort = () => reject(new Error('S2S timeout'));
  if (signal.aborted) rejectOnAbort();
  else signal.addEventListener('abort', rejectOnAbort, { once: true });
});

export const createS2sDinnerContextService = (dependencies: S2sDinnerContextDependencies) => {
  const requestBudgets = new WeakMap<object, S2sRequestBudget>();
  const beginRequest = async (ip: string, requestKey?: object, onDeadline?: () => void, disconnectSignal?: AbortSignal): Promise<S2sRequestPreflight> => {
    if (!dependencies.enabled) return { result: { status: 404, body: { code: 'not_found' } } };
    if (!dependencies.rateLimiter) return { result: { status: 503, body: { code: 'service_unavailable' } } };

    const timeoutMs = dependencies.requestTimeoutMs ?? 5000;
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    const relayDisconnect = () => controller.abort();
    if (disconnectSignal?.aborted) controller.abort();
    else disconnectSignal?.addEventListener('abort', relayDisconnect, { once: true });
    const timer = setTimeout(() => { controller.abort(); try { onDeadline?.(); } catch { /* timeout notification must not destabilize request cleanup */ } }, timeoutMs);
    const budget: S2sRequestBudget = {
      deadlineAt,
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => {
        clearTimeout(timer);
        disconnectSignal?.removeEventListener('abort', relayDisconnect);
      },
    };

    try {
      const allowed = await Promise.race([dependencies.rateLimiter.allow(null, ip), waitForAbort(controller.signal)]);
      if (controller.signal.aborted || Date.now() >= deadlineAt) throw new Error('S2S timeout');
      if (!allowed) {
        budget.dispose();
        return { result: { status: 429, body: { code: 'rate_limited' }, retryAfter: 60 } };
      }
      if (requestKey !== undefined) requestBudgets.set(requestKey, budget);
      return { budget };
    } catch {
      budget.dispose();
      return { result: { status: 503, body: { code: 'service_unavailable' } } };
    }
  };

  const getRequestBudget = (requestKey: object) => requestBudgets.get(requestKey);
  const isRequestExpired = (requestKey: object) => {
    const budget = requestBudgets.get(requestKey);
    return budget !== undefined && (budget.signal.aborted || Date.now() >= budget.deadlineAt);
  };
  const finishRequest = (requestKey: object) => {
    requestBudgets.get(requestKey)?.dispose();
    requestBudgets.delete(requestKey);
  };

  const abortRequest = (requestKey: object) => {
    const budget = requestBudgets.get(requestKey);
    budget?.abort();
    budget?.dispose();
  };

  const read = async (authorization: string | undefined, hasBrowserCredential: boolean, hasSelector: boolean, hasQuery: boolean, hasBody: boolean, ip = 'unknown', hasDuplicateAuthorization = false, existingBudget?: S2sRequestBudget): Promise<ServiceResult> => {
    if (!dependencies.enabled) return { status: 404, body: { code: 'not_found' } };
    const ownsBudget = existingBudget === undefined;
    const preflight = existingBudget === undefined ? await beginRequest(ip) : { budget: existingBudget };
    if ('result' in preflight) return preflight.result;
    const budget = preflight.budget;
    const rateLimiter = dependencies.rateLimiter;
    if (!rateLimiter) return { status: 503, body: { code: 'service_unavailable' } };
    const deadline = () => waitForAbort(budget.signal);
    let snapshot;
    try {
      if (budget.signal.aborted || Date.now() >= budget.deadlineAt) throw new Error('S2S timeout');
      const candidate = !hasDuplicateAuthorization && typeof authorization === 'string' && authorization.startsWith('Bearer ') && !authorization.includes(',')
        ? authorization.slice(7)
        : undefined;
      const presentedCredential = candidate && tokenPattern.test(candidate) ? candidate : null;
      if (presentedCredential !== null) {
        const allowed = await Promise.race([rateLimiter.allow(presentedCredential, ip, { includeIp: false, bucket: 'presented' }), deadline()]);
        if (budget.signal.aborted || Date.now() >= budget.deadlineAt) throw new Error('S2S timeout');
        if (!allowed) return { status: 429, body: { code: 'rate_limited' }, retryAfter: 60 };
      }
      if (hasDuplicateAuthorization || hasBrowserCredential || hasSelector || hasQuery || hasBody) return { status: 400, body: { code: 'invalid_request' } };
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.includes(',')) return { status: 401, body: { code: 'service_auth_required' } };
      const supplied = authorization.slice(7);
      if (!tokenPattern.test(supplied)) return { status: 401, body: { code: 'service_auth_required' } };
      const remainingMs = Math.max(1, budget.deadlineAt - Date.now());
      snapshot = await Promise.race([
        dependencies.source.readAuthorizedSnapshot(supplied, { signal: budget.signal, timeoutMs: remainingMs }),
        deadline(),
      ]);
      if (snapshot) {
        const credentialAllowed = await Promise.race([
          rateLimiter.allow(snapshot.grant.keyId, ip, { includeIp: false, bucket: 'credential' }),
          deadline(),
        ]);
        if (budget.signal.aborted || Date.now() >= budget.deadlineAt) throw new Error('S2S timeout');
        if (!credentialAllowed) return { status: 429, body: { code: 'rate_limited' }, retryAfter: 60 };
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'service_access_denied') return { status: 403, body: { code: 'service_access_denied' } };
      if (error instanceof Error && 'code' in error && error.code === 'service_auth_required') return { status: 401, body: { code: 'service_auth_required' } };
      if (error instanceof Error && 'code' in error && (error.code === 'snapshot_limit_exceeded' || error.code === 'pantry_representation_unsupported')) return { status: 409, body: { code: error.code } };
      return { status: 503, body: { code: 'service_unavailable' } };
    } finally {
      if (ownsBudget) budget.dispose();
    }
    if (!snapshot) return { status: 401, body: { code: 'service_auth_required' } };
    const { grant, pantryLots, dietProfile } = snapshot;
    if (grant.scope !== 'dinner-context:read' || !grant.enabled || Date.parse(grant.expiresAt) <= (dependencies.clock?.() ?? new Date()).getTime()) return { status: 401, body: { code: 'service_auth_required' } };
    if (pantryLots.length > 2000) return { status: 409, body: { code: 'snapshot_limit_exceeded' } };
    const lotFields = new Set(['id', 'ingredientId', 'label', 'known', 'quantity', 'unit', 'expiresAt', 'createdAt', 'updatedAt']);
    const pantryLotsForResponse = pantryLots.flatMap((lot) => {
      if (lot === null || typeof lot !== 'object' || Array.isArray(lot) || Object.keys(lot).some((field) => !lotFields.has(field))) return [];
      const parsed = pantryLotDetailsSchema.safeParse(lot);
      return parsed.success ? [parsed.data] : [];
    });
    if (pantryLotsForResponse.length !== pantryLots.length) return { status: 503, body: { code: 'service_unavailable' } };
    if (dietProfile !== null && (!isDietProfile(dietProfile) || !validProfile(dietProfile))) return { status: 503, body: { code: 'service_unavailable' } };
    const result: DinnerContext = { schemaVersion: 1, retrievedAt: (dependencies.clock?.() ?? new Date()).toISOString(), pantry: { lots: pantryLotsForResponse }, dietaryConstraints: dietProfile === null ? { status: 'not_configured' } : { status: 'configured', diet: dietProfile.diet, excludedAllergens: [...dietProfile.excludedAllergens] } };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) return { status: 409, body: { code: 'snapshot_limit_exceeded' } };
    return { status: 200, body: result };
  };

  return { beginRequest, getRequestBudget, isRequestExpired, finishRequest, abortRequest, read };
};
export type S2sDinnerContextService = ReturnType<typeof createS2sDinnerContextService>;
