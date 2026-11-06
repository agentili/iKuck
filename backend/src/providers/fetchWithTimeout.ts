export class FetchTimeoutError extends Error {
  readonly code = 'provider_timeout';

  constructor() {
    super('Provider request timed out');
    this.name = 'FetchTimeoutError';
  }
}

const callerAbortReason = (signal: AbortSignal): unknown => signal.reason
  ?? new DOMException('The operation was aborted', 'AbortError');

export interface TrackedFetch<T> {
  response: Promise<T>;
  settled: Promise<void>;
}

// Settlement observes the fetch and body consumer, including late outcomes.
export function fetchWithTrackedBody<T>(
  fetchImpl: typeof fetch, input: RequestInfo | URL, init: RequestInit,
  timeoutMs: number, consumeResponse: (response: Response) => Promise<T>,
): TrackedFetch<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Provider timeout must be a positive finite number');
  const signal = init.signal;
  if (signal?.aborted) return { response: Promise.reject(callerAbortReason(signal)), settled: Promise.resolve() };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let removeListener = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new FetchTimeoutError()); }, timeoutMs);
  });
  const aborted = signal == null ? null : new Promise<never>((_resolve, reject) => {
    const onAbort = () => { controller.abort(signal.reason); reject(callerAbortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  let fetchPromise: Promise<Response>;
  try { fetchPromise = Promise.resolve(fetchImpl(input, { ...init, signal: controller.signal })); }
  catch (error) { fetchPromise = Promise.reject(error); }
  const work = fetchPromise.then(consumeResponse);
  const settled = work.then(() => {}, () => {});
  const response = Promise.race(aborted ? [work, timeout, aborted] : [work, timeout])
    .finally(() => { clearTimeout(timer); removeListener(); });
  return { response, settled };
}

export async function fetchWithTimeoutBody<T>(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consumeResponse: (response: Response) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Provider timeout must be a positive finite number');
  }

  const callerSignal = init.signal;
  if (callerSignal?.aborted) throw callerAbortReason(callerSignal);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeCallerListener: (() => void) | undefined;
  let timedOut = false;
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

  let fetchPromise: Promise<Response>;
  try {
    // Invoke fetch before yielding so dispatch happens inside any surrounding consent lock.
    fetchPromise = Promise.resolve(fetchImpl(input, {
      ...init,
      signal: controller.signal,
    }));
  } catch (error) {
    fetchPromise = Promise.reject(error);
  }

  try {
    const pendingFetch = callerAbortPromise === null
      ? [fetchPromise, timeoutPromise]
      : [fetchPromise, timeoutPromise, callerAbortPromise];
    const response = await Promise.race(pendingFetch);
    const responsePromise = Promise.resolve().then(() => consumeResponse(response));
    const pendingResponse = callerAbortPromise === null
      ? [responsePromise, timeoutPromise]
      : [responsePromise, timeoutPromise, callerAbortPromise];
    return await Promise.race(pendingResponse);
  } catch (error) {
    if (timedOut) throw new FetchTimeoutError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeCallerListener?.();
  }
}

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
