import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client.js';
import { loadConfig } from '../config.js';
import { runImageTick } from './repository.js';

vi.mock('../db/client.js', () => ({ createDatabase: vi.fn() }));
vi.mock('../config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('./repository.js', () => ({ runImageTick: vi.fn() }));
vi.mock('./config.js', () => ({ imageConfig: () => ({ enabled: false }) }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps the disabled Compose worker idle without database or provider calls and handles shutdown', async () => {
  vi.useFakeTimers();
  const signals = vi.spyOn(process, 'once');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  await import('./worker.js');
  const handlers = signals.mock.calls.filter(([name]) => name === 'SIGINT' || name === 'SIGTERM');
  try {
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(runImageTick).not.toHaveBeenCalled();
    const stop = handlers.find(([name]) => name === 'SIGTERM')?.[1] as (() => void) | undefined;
    expect(stop).toBeDefined();
    stop!();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
});
