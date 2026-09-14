import { describe, expect, it, vi } from 'vitest';
import { createMemorySyncRepository } from './repository.js';

const mutation = (clientUpdatedAt: string, mutationId: string, label: string) => ({
  mutationId,
  deviceId: 'device-1',
  entityType: 'pantry_item' as const,
  entityId: 'tomato',
  operation: 'upsert' as const,
  payload: { id: 'tomato', label, known: true },
  clientUpdatedAt,
});

describe('sync repository', () => {
  it('keeps the newer mutation and ignores an older mutation for the same entity', async () => {
    const repository = createMemorySyncRepository();
    await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-new', 'Pomodoro'));
    const result = await repository.applyMutation('user-1', mutation('2026-09-12T11:00:00.000Z', 'mutation-old', 'Vecchio'));

    expect(result.applied).toBe(false);
    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      payload: { label: 'Pomodoro' },
    });
  });

  it('applies the same mutation only once and returns a server sequence', async () => {
    const repository = createMemorySyncRepository();
    const first = await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-1', 'Pomodoro'));
    const second = await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-1', 'Pomodoro'));

    expect(first.applied).toBe(true);
    expect(first.change?.serverSequence).toBe(1);
    expect(second.applied).toBe(false);
  });

  it('clamps a client timestamp ten minutes in the future and emits a private-data-free warning', async () => {
    const warn = vi.fn();
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({
      clock: () => serverNow,
      logger: { warn },
      maxClientClockSkewMs: 5 * 60 * 1000,
    });

    await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'future-mutation', 'Private label'),
      deviceId: 'device-future',
    });

    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      clientUpdatedAt: serverNow,
      payload: { label: 'Private label' },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Sync client timestamp exceeded the configured clock skew tolerance');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private label');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('device-future');
  });

  it('resolves equally skewed devices deterministically by device id', async () => {
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({ clock: () => serverNow, logger: { warn: () => undefined } });

    await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'device-b-mutation', 'Device B'),
      deviceId: 'device-b',
    });
    const second = await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'device-a-mutation', 'Device A'),
      deviceId: 'device-a',
    });

    expect(second.applied).toBe(false);
    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      payload: { label: 'Device B' },
      clientUpdatedAt: serverNow,
    });
  });

  it('honors a larger configured tolerance', async () => {
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({
      clock: () => serverNow,
      maxClientClockSkewMs: 15 * 60 * 1000,
    });

    await repository.applyMutation('user-1', mutation('2026-09-13T12:10:00.000Z', 'allowed-future', 'Allowed future'));

    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      clientUpdatedAt: new Date('2026-09-13T12:10:00.000Z'),
    });
  });
});
