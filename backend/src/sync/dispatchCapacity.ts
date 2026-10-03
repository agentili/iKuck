export class DispatchCapacityError extends Error {
  readonly code = 'ai_dispatch_capacity';
  readonly status = 503;

  constructor(reason: 'queue_full' | 'queue_timeout') {
    super(reason === 'queue_full' ? 'AI dispatch queue is full' : 'AI dispatch queue timed out');
    this.name = 'DispatchCapacityError';
  }
}

export class DispatchAbortedError extends Error {
  readonly code = 'ai_dispatch_aborted';
  readonly status = 503;

  constructor() {
    super('AI dispatch was cancelled while waiting for capacity');
    this.name = 'DispatchAbortedError';
  }
}

interface QueuedDispatch {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

export interface DispatchCapacityGateOptions {
  maxQueueSize?: number;
  waitTimeoutMs?: number;
}

export interface DispatchCapacityGate {
  readonly capacity: number;
  readonly activeCount: number;
  readonly queuedCount: number;
  acquire: (signal?: AbortSignal) => Promise<() => void>;
}

export const createDispatchCapacityGate = (
  maxConnections: number,
  options: DispatchCapacityGateOptions = {},
): DispatchCapacityGate => {
  const normalizedMax = Number.isFinite(maxConnections) ? Math.max(1, Math.floor(maxConnections)) : 1;
  const capacity = Math.min(2, Math.max(1, Math.floor(normalizedMax / 5)));
  const maxQueueSize = options.maxQueueSize ?? capacity * 4;
  const waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
  let active = 0;
  const queue: QueuedDispatch[] = [];

  const removeWaiter = (waiter: QueuedDispatch): boolean => {
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    return true;
  };

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      while (active < capacity && queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        clearTimeout(next.timer);
        if (next.signal !== undefined && next.abortListener !== undefined) {
          next.signal.removeEventListener('abort', next.abortListener);
        }
        if (next.signal?.aborted) {
          next.reject(new DispatchAbortedError());
          continue;
        }
        active += 1;
        next.resolve(makeRelease());
      }
    };
  };

  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new DispatchAbortedError());
    if (active < capacity && queue.length === 0) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    if (queue.length >= maxQueueSize) return Promise.reject(new DispatchCapacityError('queue_full'));

    return new Promise((resolve, reject) => {
      const waiter: QueuedDispatch = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        timer: setTimeout(() => {
          if (removeWaiter(waiter)) reject(new DispatchCapacityError('queue_timeout'));
        }, waitTimeoutMs),
      };
      if (signal !== undefined) {
        waiter.abortListener = () => {
          if (removeWaiter(waiter)) reject(new DispatchAbortedError());
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      queue.push(waiter);
      if (signal?.aborted) waiter.abortListener?.();
    });
  };

  return {
    capacity,
    get activeCount() { return active; },
    get queuedCount() { return queue.length; },
    acquire,
  };
};
