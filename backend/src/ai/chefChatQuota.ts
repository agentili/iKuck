export type QuotaReservation =
  | { kind: 'allowed'; operationId: string; token: string }
  | { kind: 'limited'; retryAfterSeconds?: number }
  | { kind: 'unavailable' };

export type QuotaCounts = {
  active_user: number;
  active_global: number;
  daily: number;
  minute: number;
  minute_retry: number;
  day_retry: number;
}

export function decideQuota(counts: QuotaCounts): { kind: 'allowed' } | { kind: 'limited'; retryAfterSeconds?: number } {
  if (counts.active_user >= 1 || counts.active_global >= 8) return { kind: 'limited' };
  if (counts.daily >= 30) return { kind: 'limited', retryAfterSeconds: counts.day_retry };
  if (counts.minute >= 5) return { kind: 'limited', retryAfterSeconds: counts.minute_retry };
  return { kind: 'allowed' };
}

export interface ChefChatQuotaStore {
  reserve(userId: string): Promise<QuotaReservation>;
  cancel?(id: string, token: string): Promise<boolean>;
  dispatch?(id: string, token: string): Promise<boolean>;
}

export function createChefChatQuota(cache: { ping(): Promise<unknown>; reserve?(userId: string, id: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>; release?(userId: string, id: string): Promise<void> }, store: ChefChatQuotaStore, options: { timeoutMs?: number } = {}) {
  let checking = false;
  async function guarded<T>(operation: (expired: () => boolean) => Promise<T>, fallback: T): Promise<T> {
    if (checking) return fallback;
    checking = true;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(async () => {
      const response = await cache.ping();
      if (response !== undefined && response !== 'PONG') throw new Error('Invalid Redis ping');
      if (expired) return fallback;
      return operation(() => expired);
    });
    void work.then(() => { checking = false; }, () => { checking = false; });
    try {
      return await Promise.race([work, new Promise<T>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve(fallback); }, options.timeoutMs ?? 1000);
      })]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    reserve: (userId: string): Promise<QuotaReservation> => guarded(async (expired) => {
      if (!cache.reserve || !store.cancel) return { kind: 'unavailable' };
      const reservation = await store.reserve(userId);
      if (reservation.kind !== 'allowed') return reservation;
      const cancel = () => store.cancel!(reservation.operationId, reservation.token);
      if (expired()) {
        await cancel();
        return { kind: 'unavailable' };
      }
      let mirror: { allowed: boolean; retryAfterSeconds?: number };
      try {
        mirror = await cache.reserve(userId, reservation.operationId);
      } catch {
        await cancel();
        return { kind: 'unavailable' };
      }
      if (!mirror.allowed || expired()) {
        const cancelled = await cancel();
        if (cancelled && mirror.allowed && cache.release) await cache.release(userId, reservation.operationId).catch(() => undefined);
        if (!cancelled || expired()) return { kind: 'unavailable' };
        return { kind: 'limited', retryAfterSeconds: mirror.retryAfterSeconds };
      }
      return reservation;
    }, { kind: 'unavailable' }),
    cancel: (userId: string, id: string, token: string): Promise<boolean> => guarded(async () => {
      if (!store.cancel || !cache.release || !await store.cancel(id, token)) return false;
      await cache.release(userId, id);
      return true;
    }, false),
    dispatch: (id: string, token: string): Promise<boolean> => guarded(() => cache.reserve && store.dispatch ? store.dispatch(id, token) : Promise.resolve(false), false),
  };
}
