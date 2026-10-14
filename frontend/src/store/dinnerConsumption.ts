import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { getActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { isScopeWritable } from '../sync/scopeWriteFence';
import { setPantryPersistenceSuspended } from '../storage/pantryStorage';
import { commitDinnerConsumption as commitStoredDinnerConsumption } from '../storage/dinnerConsumptionStorage';
import type { CommittedDinnerConsumption } from '../storage/dinnerConsumptionStorage';
import { usePantryStore } from './localPantryStore';

export class DinnerConsumptionScopeError extends Error {
  readonly code = 'scope_changed';

  constructor() {
    super('The active data scope changed before dinner confirmation completed');
    this.name = 'DinnerConsumptionScopeError';
  }
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const assertActiveScope = (scope: SyncScope): void => {
  if (getActiveDataScope() !== scope || !isScopeWritable(scope)) throw new DinnerConsumptionScopeError();
};

export async function coordinateDinnerConsumption({
  command: inputCommand,
  entry: inputEntry,
  cookEvent: inputCookEvent,
  updatedAt,
}: {
  command: DinnerConsumptionCommand;
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  updatedAt?: string;
}): Promise<CommittedDinnerConsumption> {
  const command = cloneJson(inputCommand);
  const entry = cloneJson(inputEntry);
  const cookEvent = inputCookEvent === undefined ? undefined : cloneJson(inputCookEvent);
  const scope = command.scope;
  assertActiveScope(scope);

  const committed = await commitStoredDinnerConsumption({ command, entry, cookEvent, updatedAt });
  assertActiveScope(scope);

  setPantryPersistenceSuspended(true);
  try {
    usePantryStore.setState({
      pantryItems: committed.pantrySnapshot.pantryItems,
      stapleIds: committed.pantrySnapshot.stapleIds,
      pantryLots: committed.pantrySnapshot.pantryLots ?? [],
    });
  } finally {
    setPantryPersistenceSuspended(false);
  }
  return committed;
}
