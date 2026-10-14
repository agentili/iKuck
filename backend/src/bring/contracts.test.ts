import { describe, expect, it } from 'vitest';
import type {
  BringConnected,
  BringCredentials,
  BringItem,
  BringList,
  BringMutation,
  BringSnapshot,
  BringStatus,
} from '@ikuck/shared/bring';

type CredentialField = 'email' | 'password' | 'token' | 'accessToken' | 'refreshToken';
type ExcludesCredentials<T> = Extract<keyof T, CredentialField> extends never ? true : false;
type PublicDtosExcludeCredentials =
  ExcludesCredentials<BringList>
  & ExcludesCredentials<BringStatus>
  & ExcludesCredentials<BringConnected>
  & ExcludesCredentials<BringItem>
  & ExcludesCredentials<BringSnapshot>
  & ExcludesCredentials<BringMutation>;
const publicDtosExcludeCredentials: PublicDtosExcludeCredentials = true;
void publicDtosExcludeCredentials;

describe('Bring shared contract', () => {
  it('exports one set of bounded external-list limits', async () => {
    const contract = await import('@ikuck/shared/bring');

    expect(contract.BRING_NAME_MAX_LENGTH).toBe(100);
    expect(contract.BRING_SPEC_MAX_LENGTH).toBe(240);
    expect(contract.BRING_LIST_ID_MAX_LENGTH).toBe(128);
    expect(contract.BRING_TIMEOUT_MS).toBe(12000);
    expect(contract.BRING_MAX_ITEMS).toBe(5000);
  });

  it('keeps credentials out of public DTO examples', async () => {
    const contract = await import('@ikuck/shared/bring');
    const status = { enabled: true, connected: true, connectionId: 'connection-1' } satisfies BringStatus;
    const list = { id: 'list-1', name: 'Spesa' } satisfies BringList;
    const connected = { ...status, lists: [list] } satisfies BringConnected;
    const item = {
      name: 'Latte',
      label: 'Latte',
      specification: '2 l',
      state: 'purchase',
      mutable: true,
    } satisfies BringItem;
    const snapshot = {
      connectionId: 'connection-1',
      listId: 'list-1',
      labelsAvailable: true,
      items: [item],
    } satisfies BringSnapshot;
    const mutation = {
      connectionId: 'connection-1',
      listId: 'list-1',
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    } satisfies BringMutation;
    const credentials: BringCredentials = {
      email: 'test@example.com',
      password: 'synthetic-password',
      confirmExternalAccess: true,
    };
    const publicDtos: object[] = [status, connected, list, item, snapshot, mutation];
    const forbiddenFields = ['email', 'password', 'token', 'accessToken', 'refreshToken'];

    expect(contract.BRING_MAX_ITEMS).toBe(5000);
    expect(credentials.confirmExternalAccess).toBe(true);
    for (const dto of publicDtos) {
      for (const field of forbiddenFields) {
        expect(dto).not.toHaveProperty(field);
      }
    }
  });
});
