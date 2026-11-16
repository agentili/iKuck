import { afterEach, expect, it, vi } from 'vitest';
import { createSyncScheduler } from './syncScheduler';

afterEach(() => { vi.useRealTimers(); });

it('debounces local writes without starving the 30 second pull', async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockResolvedValue(true);
  const scheduler = createSyncScheduler(run, () => true);
  for (let i = 0; i < 10; i++) scheduler.request();
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('serializes requests and retains a mutation arriving during a sync', async () => {
  vi.useFakeTimers();
  let finish!: (success: boolean) => void;
  const run = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValue(true);
  const scheduler = createSyncScheduler(run, () => true);
  scheduler.request();
  await vi.advanceTimersByTimeAsync(250);
  scheduler.request();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(1);
  finish(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('backs off failures even when new writes arrive and cancels after cleanup', async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockResolvedValue(false);
  const scheduler = createSyncScheduler(run, () => true);
  scheduler.request();
  await vi.advanceTimersByTimeAsync(250);
  scheduler.request();
  await vi.advanceTimersByTimeAsync(999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  scheduler.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it('does not run with a stale session/scope or while offline', async () => {
  vi.useFakeTimers();
  let allowed = false;
  const run = vi.fn().mockResolvedValue(true);
  const scheduler = createSyncScheduler(run, () => allowed);
  scheduler.request();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).not.toHaveBeenCalled();
  allowed = true;
  scheduler.request();
  await vi.advanceTimersByTimeAsync(250);
  expect(run).toHaveBeenCalledOnce();
  scheduler.stop();
});
