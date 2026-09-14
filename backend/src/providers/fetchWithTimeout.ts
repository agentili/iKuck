export class FetchTimeoutError extends Error {
  readonly code = 'provider_timeout';

  constructor() {
    super('Provider request timed out');
    this.name = 'FetchTimeoutError';
  }
}

const callerAbortReason = (signal: AbortSignal): unknown => signal.reason
  ?? new DOMException('The operation was aborted', 'AbortError');

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Provider timeout must be a positive finite number');
  }

  const callerSignal = init.signal;
  if (callerSignal?.aborted) throw callerAbortReason(callerSignal);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeCallerListener: (() => void) | undefined;
  let timedOut = false;

  const fetchPromise = Promise.resolve().then(() => fetchImpl(input, {
    ...init,
    signal: controller.signal,
  }));
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new FetchTimeoutError());
    }, timeoutMs);
  });
  const callerAbortPromise = callerSignal === null || callerSignal === undefined
    ? null
    : new Promise<never>((_resolve, reject) => {
      const onCallerAbort = () => {
        controller.abort(callerSignal.reason);
        reject(callerAbortReason(callerSignal));
      };
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      removeCallerListener = () => callerSignal.removeEventListener('abort', onCallerAbort);
    });

  try {
    const pending = callerAbortPromise === null
      ? [fetchPromise, timeoutPromise]
      : [fetchPromise, timeoutPromise, callerAbortPromise];
    return await Promise.race(pending);
  } catch (error) {
    if (timedOut) throw new FetchTimeoutError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeCallerListener?.();
  }
}
