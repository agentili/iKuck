import { authenticate as sdkAuthenticate, createBringClient, getCatalog, isBringApiError } from '@micsob/bring-api-client';
import { BRING_LIST_ID_MAX_LENGTH, BRING_MAX_ITEMS, type BringAction, type BringList } from '@ikuck/shared/bring';
import { z } from 'zod';
import { BringError } from './errors.js';

const listsSchema = z.object({
  lists: z.array(z.object({
    listUuid: z.string().min(1).max(BRING_LIST_ID_MAX_LENGTH),
    name: z.string().max(1000),
    theme: z.string().max(128),
  })).max(1000),
});
const itemsSchema = z.object({
  uuid: z.string().max(128),
  status: z.string().max(128),
  purchase: z.array(z.object({
    name: z.string().min(1).max(1000),
    specification: z.string().max(10000),
  })).max(BRING_MAX_ITEMS),
  recently: z.array(z.object({
    name: z.string().min(1).max(1000),
    specification: z.string().max(10000),
  })).max(BRING_MAX_ITEMS),
});
const catalogSchema = z.object({
  language: z.string().max(128),
  catalog: z.object({
    sections: z.array(z.object({
      sectionId: z.string().max(128),
      name: z.string().max(1000),
      items: z.array(z.object({
        itemId: z.string().min(1).max(128),
        name: z.string().max(1000),
      })).max(BRING_MAX_ITEMS),
    })).max(1000),
  }),
}).refine((value) => value.catalog.sections.reduce((total, section) => total + section.items.length, 0) <= BRING_MAX_ITEMS);

export const sessionSchema = z.object({
  userId: z.string().min(1).max(128),
  accessToken: z.string().min(1).max(8192),
  userName: z.string().max(1000).optional(),
}).strict();

export type StoredSession = z.infer<typeof sessionSchema>;
export type RawItems = z.infer<typeof itemsSchema>;

export interface CatalogEntry {
  itemId: string;
  name: string;
}

export interface GatewayChange {
  listId: string;
  name: string;
  specification: string;
  action: BringAction;
}

export interface BringGateway {
  authenticate(credentials: { email: string; password: string }, signal: AbortSignal): Promise<StoredSession>;
  lists(session: StoredSession, signal: AbortSignal): Promise<BringList[]>;
  items(session: StoredSession, listId: string, signal: AbortSignal): Promise<RawItems>;
  catalog(signal: AbortSignal): Promise<CatalogEntry[]>;
  change(session: StoredSession, input: GatewayChange, signal: AbortSignal): Promise<void>;
}

export const createBringGateway = (fetchImpl: typeof fetch = globalThis.fetch): BringGateway => {
  const run = async <T>(stage: 'auth' | 'operation', operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BringError) throw error;
      if (isBringApiError(error) && (error.status === 401 || error.status === 403) && stage === 'auth') {
        throw new BringError('bring_invalid_credentials', 401);
      }
      if (isBringApiError(error) && error.status === 401) {
        throw new BringError('bring_reconnect_required', 409);
      }
      if (isBringApiError(error) && error.status === 403) {
        throw new BringError('bring_list_not_found', 404);
      }
      throw new BringError('bring_unavailable', 503);
    }
  };
  const client = (session: StoredSession) => createBringClient({ session, fetch: fetchImpl, country: 'IT' });

  return {
    authenticate: (credentials, signal) => run('auth', async () => {
      const session = await sdkAuthenticate(credentials, { fetch: fetchImpl, signal });
      return sessionSchema.parse({
        userId: session.userId,
        accessToken: session.accessToken,
        ...(session.userName === undefined ? {} : { userName: session.userName }),
      });
    }),
    lists: (session, signal) => run('operation', async () => listsSchema.parse(
      await client(session).lists.getAll({ signal }),
    ).lists.map((list) => ({ id: list.listUuid, name: list.name }))),
    items: (session, listId, signal) => run('operation', async () => itemsSchema.parse(
      await client(session).lists.getItems({ listId }, { signal }),
    )),
    catalog: (signal) => run('operation', async () => catalogSchema.parse(
      await getCatalog({ locale: 'it-IT', fetch: fetchImpl, signal }),
    ).catalog.sections.flatMap((section) => section.items)),
    change: (session, input, signal) => run('operation', async () => {
      const lists = client(session).lists;
      const { listId, name, specification } = input;
      if (input.action === 'complete') await lists.moveItemToRecent({ listId, name }, { signal });
      else if (input.action === 'remove') await lists.removeItem({ listId, name }, { signal });
      else await lists.saveItem({ listId, name, specification }, { signal });
    }),
  };
};
