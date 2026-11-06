import type { PlanCommand, SyncMutationScope } from '@ikuck/shared/contracts';
import type { SyncScope } from '../sync/scopeContext';
import { assertScopeWritable, waitForScopedWrites } from '../sync/scopeWriteFence';
import type { MealPlanApi } from './api';
import { mealPlanApi } from './api';
import {
  clearMealPlanSnapshot,
  commitMealPlanCommand,
  readMealPlanOutbox,
  readMealPlanSnapshot,
  type MealPlanOutboxRecord,
} from './storage';

export interface AccountMealPlanImportSummary {
  acknowledged: number;
  conflicts: number;
  pending: number;
}

const IMPORT_BATCH_SIZE = 100;

const getImportSource = (record: MealPlanOutboxRecord, accountScope: SyncScope) => {
  if (record.sourceScope !== undefined
    && (record.sourceScope !== 'guest' || record.sourceRevision === undefined)) {
    throw new Error('La coda del Piano contiene una provenienza di account non riconosciuta.');
  }
  const localRevision = String(record.localOrder);
  return {
    source: 'account' as const,
    sourceId: record.mutationId,
    localRevision,
    provenance: { scope: accountScope, revision: localRevision },
  };
};

const toTargetCommand = (command: PlanCommand, targetScope: SyncMutationScope): PlanCommand => ({
  ...command,
  scope: targetScope,
});

export async function importPendingAccountMealPlan(input: {
  accountScope: SyncScope;
  targetScope: SyncScope;
  csrfToken: string;
  api?: MealPlanApi;
  isCurrent?: () => boolean;
}): Promise<AccountMealPlanImportSummary> {
  const { accountScope, targetScope, csrfToken, api = mealPlanApi, isCurrent = () => true } = input;
  if (!accountScope.startsWith('account:') || !targetScope.startsWith('house:')) {
    throw new Error('Il recupero del Piano account richiede un account sorgente e una Casa verificata.');
  }
  const target = targetScope as SyncMutationScope;
  const assertCurrent = (): void => {
    if (!isCurrent()) throw new Error('La sessione o la Casa è cambiata durante il recupero del Piano account.');
    assertScopeWritable(accountScope);
    assertScopeWritable(targetScope);
  };
  assertCurrent();
  await Promise.all([waitForScopedWrites(accountScope), waitForScopedWrites(targetScope)]);
  assertCurrent();
  const outbox = await readMealPlanOutbox([accountScope], assertCurrent);
  assertCurrent();
  if (outbox.length === 0) return { acknowledged: 0, conflicts: 0, pending: 0 };

  await api.getCapabilities();
  assertCurrent();
  let acknowledged = 0;
  let conflicts = 0;

  for (let offset = 0; offset < outbox.length; offset += IMPORT_BATCH_SIZE) {
    assertCurrent();
    const batch = outbox.slice(offset, offset + IMPORT_BATCH_SIZE);
    const items = batch.map((record) => {
      if (record.scope !== accountScope || record.command.scope !== accountScope) {
        throw new Error('La coda del Piano contiene un’operazione di un altro ambito dati.');
      }
      const source = getImportSource(record, accountScope);
      return {
        source: source.source,
        sourceId: source.sourceId,
        localRevision: source.localRevision,
        command: toTargetCommand(record.command, target),
      };
    });
    const response = await api.importCommands(target, items, csrfToken);
    assertCurrent();

    for (let index = 0; index < batch.length; index += 1) {
      assertCurrent();
      const record = batch[index];
      const item = items[index];
      const receipt = response.results[index];
      if (record === undefined || item === undefined || receipt === undefined
        || receipt.sourceId !== item.sourceId || receipt.localRevision !== item.localRevision
        || receipt.result.operationId !== item.command.operationId) {
        throw new Error('La risposta di importazione non corrisponde alla coda account del Piano.');
      }

      const currentRows = await api.readStates(target, [record.command.date], csrfToken);
      assertCurrent();
      const current = currentRows.find((entry) => entry.date === record.command.date);
      if (current === undefined) throw new Error('La risposta del Piano non contiene la data richiesta.');

      const guestSourceSnapshot = record.sourceScope === 'guest'
        ? await readMealPlanSnapshot('guest')
        : null;
      assertCurrent();
      const guestSourceState = guestSourceSnapshot?.states[record.command.date];
      const source = record.sourceScope === 'guest' && record.sourceRevision !== undefined
        && guestSourceState?.revision === record.sourceRevision
        ? {
          scope: 'guest' as const,
          date: record.command.date,
          revision: record.sourceRevision,
          receiptState: guestSourceState,
        }
        : undefined;

      await commitMealPlanCommand(
        targetScope,
        accountScope,
        item.command,
        receipt.result,
        current.state,
        {
          sourceOutbox: { scope: accountScope, mutationId: record.mutationId },
          provenance: getImportSource(record, accountScope).provenance,
          ...(source === undefined ? {} : { source }),
          assertCurrent,
        },
      );
      assertCurrent();
      acknowledged += 1;
      if (receipt.result.outcome === 'conflict') conflicts += 1;
    }
  }

  const remaining = await readMealPlanOutbox([accountScope], assertCurrent);
  assertCurrent();
  if (remaining.length === 0) {
    await clearMealPlanSnapshot(accountScope);
    assertCurrent();
  }
  return { acknowledged, conflicts, pending: remaining.length };
}
