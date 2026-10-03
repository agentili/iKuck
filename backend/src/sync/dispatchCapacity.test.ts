import { describe, expect, it, vi } from 'vitest';
import { createDispatchCapacityGate, DispatchCapacityError } from './dispatchCapacity.js';

describe('AI dispatch capacity gate', () => {
  it('caps ten-connection pools at two dispatches and two-connection pools at one', () => {
    expect(createDispatchCapacityGate(10).capacity).toBe(2);
    expect(createDispatchCapacityGate(2).capacity).toBe(1);
  });

  it('grants capacity to queued dispatches in FIFO order', async () => {
    const gate = createDispatchCapacityGate(2, { maxQueueSize: 2, waitTimeoutMs: 1000 });
    const started: number[] = [];
    const releaseFirst = await gate.acquire();
    const second = gate.acquire().then((release) => { started.push(2); return release; });
    const third = gate.acquire().then((release) => { started.push(3); return release; });

    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(2);
    expect(started).toEqual([]);

    releaseFirst();
    const releaseSecond = await second;
    expect(started).toEqual([2]);
    releaseSecond();
    const releaseThird = await third;
    expect(started).toEqual([2, 3]);
    releaseThird();
    expect(gate.activeCount).toBe(0);
  });

  it('rejects excess waiters and expires the queue without retaining a slot', async () => {
    vi.useFakeTimers();
    const gate = createDispatchCapacityGate(2, { maxQueueSize: 1, waitTimeoutMs: 25 });
    const releaseFirst = await gate.acquire();
    const queued = gate.acquire();

    await expect(gate.acquire()).rejects.toBeInstanceOf(DispatchCapacityError);
    const timedOut = expect(queued).rejects.toMatchObject({ code: 'ai_dispatch_capacity' });
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;
    expect(gate.queuedCount).toBe(0);
    expect(gate.activeCount).toBe(1);

    releaseFirst();
    expect(gate.activeCount).toBe(0);
    vi.useRealTimers();
  });

  it('removes an aborted waiter and rejects it before acquiring a dispatch slot', async () => {
    const gate = createDispatchCapacityGate(2, { maxQueueSize: 2, waitTimeoutMs: 1000 });
    const releaseFirst = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ code: 'ai_dispatch_aborted' });
    expect(gate.queuedCount).toBe(0);
    releaseFirst();
    expect(gate.activeCount).toBe(0);
  });
});
