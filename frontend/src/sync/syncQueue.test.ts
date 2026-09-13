import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PantryLot, SyncChangeSet, SyncMutation } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, readMeta } from '../storage/indexedDb';
import { readPantrySnapshot } from '../storage/pantryStorage';
import {
  enqueueMutation,
  getDeviceId,
  readQueuedMutations,
  readSyncCursor,
  syncNow,
} from './syncQueue';

const session = {
  userId: 'user-1',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
  csrfToken: 'csrf-1',
};

const sampleMutation = (mutationId = 'mutation-1', clientUpdatedAt = '2026-09-12T12:00:00.000Z'): SyncMutation => ({
  mutationId,
  deviceId: 'device-1',
  entityType: 'pantry_item',
  entityId: 'pasta',
  operation: 'upsert',
  payload: { id: 'pasta', label: 'Pasta', known: true },
  clientUpdatedAt,
});

const responseFor = (body: SyncChangeSet) => new Response(JSON.stringify(body), { status: 200 });

describe('sync queue', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('creates a device id once without storing account secrets', async () => {
    const first = await getDeviceId();
    const second = await getDeviceId();

    expect(second).toBe(first);
    await expect(readMeta('deviceId')).resolves.toBe(first);
    expect(first).not.toContain('csrf');
  });

  it('queues mutations in timestamp order and remains idempotent by mutation id', async () => {
    await enqueueMutation(sampleMutation('mutation-2', '2026-09-12T12:02:00.000Z'));
    await enqueueMutation(sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));
    await enqueueMutation(sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));

    expect((await readQueuedMutations()).map(({ mutationId }) => mutationId)).toEqual([
      'mutation-1',
      'mutation-2',
    ]);
  });

  it('keeps mutations queued when the sync request fails', async () => {
    await enqueueMutation(sampleMutation());
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));

    await expect(syncNow({ fetch, session })).rejects.toMatchObject({ code: 'network_error' });
    await expect(readQueuedMutations()).resolves.toHaveLength(1);
  });

  it('rejects before sending when the session is not verified', async () => {
    const fetch = vi.fn();

    await expect(syncNow({
      fetch,
      session: { ...session, emailVerifiedAt: '' },
    })).rejects.toMatchObject({ code: 'email_not_verified' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('removes sent mutations, applies server changes and advances the cursor', async () => {
    await enqueueMutation(sampleMutation());
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{ ...sampleMutation(), serverSequence: 4 }],
      nextCursor: 4,
    }));

    await syncNow({ fetch, session });

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
    }));
    await expect(readQueuedMutations()).resolves.toEqual([]);
    await expect(readSyncCursor()).resolves.toBe(4);
  });

  it('applies a remote pantry lot and keeps its quantity and expiry details', async () => {
    const lot: PantryLot = {
      id: 'lot-pasta',
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 320,
      unit: 'g',
      expiresAt: '2026-09-20',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        mutationId: 'lot-change',
        deviceId: 'device-remote',
        entityType: 'pantry_lot',
        entityId: lot.id,
        operation: 'upsert',
        payload: lot,
        clientUpdatedAt: lot.updatedAt,
        serverSequence: 5,
      }],
      nextCursor: 5,
    }));

    await syncNow({ fetch, session });

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [expect.objectContaining({ id: lot.id, quantity: 320, unit: 'g', expiresAt: '2026-09-20' })],
    });
  });
});
