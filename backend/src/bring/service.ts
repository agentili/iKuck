import { randomUUID } from 'node:crypto';
import {
  BRING_NAME_MAX_LENGTH,
  BRING_SPEC_MAX_LENGTH,
  BRING_TIMEOUT_MS,
  type BringConnected,
  type BringItem,
  type BringMutation,
  type BringSnapshot,
  type BringStatus,
} from '@ikuck/shared/bring';
import { BringError } from './errors.js';
import type { BringRepository, ConnectionUnit } from './repository.js';
import type { SessionCipher } from './sessionCipher.js';
import { sessionSchema, type BringGateway, type CatalogEntry, type RawItems, type StoredSession } from './gateway.js';

const normalized = (name: string): string => name.trim().toLocaleLowerCase('it-IT');

const assertActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw new BringError('bring_unavailable', 503);
};

const callGateway = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BringError) throw error;
    throw new BringError('bring_unavailable', 503);
  }
};

const readSession = async (
  unit: ConnectionUnit,
  cipher: SessionCipher,
  userId: string,
  connectionId: string,
): Promise<StoredSession> => {
  const record = await unit.get();
  if (record === null) throw new BringError('bring_not_connected', 409);
  if (record.connectionId !== connectionId) throw new BringError('bring_stale_connection', 409);

  try {
    return sessionSchema.parse(JSON.parse(cipher.open(userId, record.encryptedSession)) as unknown);
  } catch {
    throw new BringError('bring_reconnect_required', 409);
  }
};

const authorizeList = async (session: StoredSession, listId: string, signal: AbortSignal, gateway: BringGateway): Promise<void> => {
  assertActive(signal);
  const lists = await callGateway(() => gateway.lists(session, signal));
  assertActive(signal);
  if (!lists.some((list) => list.id === listId)) throw new BringError('bring_list_not_found', 404);
};

const load = async (
  session: StoredSession,
  listId: string,
  signal: AbortSignal,
  gateway: BringGateway,
): Promise<{ raw: RawItems; catalog: CatalogEntry[]; labelsAvailable: boolean }> => {
  assertActive(signal);
  const raw = await callGateway(() => gateway.items(session, listId, signal));
  assertActive(signal);
  if (raw.uuid !== listId) throw new BringError('bring_unavailable', 503);

  let catalog: CatalogEntry[] = [];
  let labelsAvailable = true;
  try {
    catalog = await callGateway(() => gateway.catalog(signal));
  } catch {
    assertActive(signal);
    labelsAvailable = false;
  }
  assertActive(signal);
  return { raw, catalog, labelsAvailable };
};

const publicSnapshot = (
  connectionId: string,
  listId: string,
  raw: RawItems,
  catalog: CatalogEntry[],
  labelsAvailable: boolean,
): BringSnapshot => {
  const counts = new Map<string, number>();
  for (const item of [...raw.purchase, ...raw.recently]) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const labels = new Map(catalog.map((entry) => [entry.itemId, entry.name]));
  const items: BringItem[] = (['purchase', 'recently'] as const).flatMap((state) => raw[state].map((item) => ({
    ...item,
    state,
    label: labels.get(item.name) ?? item.name,
    mutable: counts.get(item.name) === 1
      && item.name.length <= BRING_NAME_MAX_LENGTH
      && item.specification.length <= BRING_SPEC_MAX_LENGTH,
  })));
  return { connectionId, listId, labelsAvailable, items };
};

export const createBringService = ({
  repository,
  cipher,
  gateway,
}: {
  repository: BringRepository;
  cipher: SessionCipher;
  gateway: BringGateway;
}) => ({
  status: (userId: string): Promise<BringStatus> => repository.withUser(userId, async (unit) => {
    const row = await unit.get();
    return { enabled: true, connected: row !== null, connectionId: row?.connectionId ?? null };
  }),

  lists: (userId: string, connectionId: string) => {
    const signal = AbortSignal.timeout(BRING_TIMEOUT_MS);
    return repository.withUser(userId, async (unit) => {
      const session = await readSession(unit, cipher, userId, connectionId);
      assertActive(signal);
      const lists = await callGateway(() => gateway.lists(session, signal));
      assertActive(signal);
      return { connectionId, lists };
    });
  },

  read: (userId: string, connectionId: string, listId: string): Promise<BringSnapshot> => {
    const signal = AbortSignal.timeout(BRING_TIMEOUT_MS);
    return repository.withUser(userId, async (unit) => {
      const session = await readSession(unit, cipher, userId, connectionId);
      await authorizeList(session, listId, signal, gateway);
      const loaded = await load(session, listId, signal, gateway);
      return publicSnapshot(connectionId, listId, loaded.raw, loaded.catalog, loaded.labelsAvailable);
    });
  },

  write: (userId: string, input: BringMutation): Promise<BringSnapshot> => {
    const signal = AbortSignal.timeout(BRING_TIMEOUT_MS);
    return repository.withUser(userId, async (unit) => {
      const session = await readSession(unit, cipher, userId, input.connectionId);
      await authorizeList(session, input.listId, signal, gateway);
      const loaded = await load(session, input.listId, signal, gateway);
      let name = input.name;
      if (input.action === 'add') {
        if (!loaded.labelsAvailable) throw new BringError('bring_unavailable', 503);
        const matches = loaded.catalog.filter((entry) => normalized(entry.name) === normalized(input.name));
        if (matches.length > 1) throw new BringError('bring_ambiguous_item', 409);
        name = matches[0]?.itemId ?? input.name;
        const existing = [...loaded.raw.purchase, ...loaded.raw.recently].filter((item) => item.name === name);
        if (existing.length > 1) throw new BringError('bring_ambiguous_item', 409);
        const existingPurchase = loaded.raw.purchase.find((item) => item.name === name);
        if (existingPurchase !== undefined) {
          if (existingPurchase.specification !== input.specification) throw new BringError('bring_item_exists', 409);
          return publicSnapshot(input.connectionId, input.listId, loaded.raw, loaded.catalog, loaded.labelsAvailable);
        }
      } else {
        if (
          input.action !== 'update'
          && input.action !== 'complete'
          && input.action !== 'restore'
          && input.action !== 'remove'
        ) {
          throw new BringError('bring_unavailable', 503);
        }
        const existing = [...loaded.raw.purchase, ...loaded.raw.recently].filter((item) => item.name === name);
        const correctGroup = input.action === 'restore' ? loaded.raw.recently : loaded.raw.purchase;
        if (existing.length > 1) throw new BringError('bring_ambiguous_item', 409);
        if (
          existing[0] === undefined
          || input.expectedSpecification === undefined
          || existing[0].specification !== input.expectedSpecification
          || (input.action !== 'remove' && !correctGroup.some((item) => item.name === name))
        ) {
          throw new BringError('bring_item_changed', 409);
        }
      }

      assertActive(signal);
      try {
        await gateway.change(session, {
          listId: input.listId,
          name,
          specification: input.specification,
          action: input.action,
        }, signal);
      } catch (error) {
        if (error instanceof BringError && error.code !== 'bring_unavailable') throw error;
        throw new BringError('bring_write_unconfirmed', 503);
      }

      let after: RawItems;
      try {
        assertActive(signal);
        after = await gateway.items(session, input.listId, signal);
        assertActive(signal);
      } catch {
        throw new BringError('bring_write_unconfirmed', 503);
      }
      if (after.uuid !== input.listId) throw new BringError('bring_write_unconfirmed', 503);
      const matchingPurchase = after.purchase.filter((item) => item.name === name);
      const matchingRecently = after.recently.filter((item) => item.name === name);
      const confirmed = input.action === 'remove'
        ? matchingPurchase.length === 0 && matchingRecently.length === 0
        : input.action === 'complete'
          ? matchingPurchase.length === 0
            && matchingRecently.length === 1
            && matchingRecently[0]?.specification === input.specification
          : matchingPurchase.length === 1
            && matchingRecently.length === 0
            && matchingPurchase[0]?.specification === input.specification;
      if (!confirmed) throw new BringError('bring_write_unconfirmed', 503);
      return publicSnapshot(input.connectionId, input.listId, after, loaded.catalog, loaded.labelsAvailable);
    });
  },

  disconnect: (userId: string, connectionId: string): Promise<void> => repository.withUser(userId, async (unit) => {
    const record = await unit.get();
    if (record === null) return;
    if (record.connectionId !== connectionId) throw new BringError('bring_stale_connection', 409);

    await unit.remove();
    if (await unit.get() !== null) throw new BringError('bring_unavailable', 503);
  }),

  connect: (userId: string, credentials: { email: string; password: string }): Promise<BringConnected> => {
    const signal = AbortSignal.timeout(BRING_TIMEOUT_MS);
    return repository.withUser(userId, async (unit) => {
      assertActive(signal);
      const received = await callGateway(() => gateway.authenticate(credentials, signal));
      const parsed = sessionSchema.safeParse(received);
      if (!parsed.success) throw new BringError('bring_unavailable', 503);
      const session = parsed.data;

      assertActive(signal);
      const lists = await callGateway(() => gateway.lists(session, signal));
      assertActive(signal);

      const connectionId = randomUUID();
      await unit.put({
        connectionId,
        encryptedSession: cipher.seal(userId, JSON.stringify(session)),
        connectedAt: new Date().toISOString(),
      });
      return { enabled: true, connected: true, connectionId, lists };
    });
  },
});

export type BringService = ReturnType<typeof createBringService>;
