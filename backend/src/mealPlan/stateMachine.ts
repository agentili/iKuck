import type { PlanCommand, PlanState } from '@ikuck/shared/contracts';

export interface ManualPlanOrder {
  clientUpdatedAt: string;
  serverUpdatedAt: string;
  deviceId: string;
  operationId: string;
}

export interface PlanDecision {
  applies: boolean;
  kind?: PlanState['kind'];
  recipeId?: string | null;
  nextManualOrder?: ManualPlanOrder;
}

export const compareManualPlanOrders = (incoming: ManualPlanOrder, current: ManualPlanOrder): number => {
  const clientDelta = Date.parse(incoming.clientUpdatedAt) - Date.parse(current.clientUpdatedAt);
  if (clientDelta !== 0) return Math.sign(clientDelta);
  const serverDelta = Date.parse(incoming.serverUpdatedAt) - Date.parse(current.serverUpdatedAt);
  if (serverDelta !== 0) return Math.sign(serverDelta);
  const deviceDelta = incoming.deviceId === current.deviceId ? 0 : incoming.deviceId > current.deviceId ? 1 : -1;
  if (deviceDelta !== 0) return deviceDelta;
  return incoming.operationId === current.operationId ? 0 : incoming.operationId > current.operationId ? 1 : -1;
};

export const decidePlanCommand = (
  current: PlanState | null,
  lastManualOrder: ManualPlanOrder | null,
  command: PlanCommand,
  normalizedClientUpdatedAt: string,
  serverUpdatedAt: string,
): PlanDecision => {
  if (command.action === 'manual_set' || command.action === 'manual_delete') {
    const incomingOrder: ManualPlanOrder = {
      clientUpdatedAt: normalizedClientUpdatedAt,
      serverUpdatedAt,
      deviceId: command.deviceId,
      operationId: command.operationId,
    };
    if (lastManualOrder !== null && compareManualPlanOrders(incomingOrder, lastManualOrder) <= 0) return { applies: false };
    return {
      applies: true,
      kind: command.action === 'manual_delete' ? 'deleted' : 'manual',
      recipeId: command.action === 'manual_delete' ? null : command.recipeId,
      nextManualOrder: incomingOrder,
    };
  }

  if (command.action === 'auto_create') {
    return current === null && command.baseRevision === null
      ? { applies: true, kind: 'automatic', recipeId: command.recipeId }
      : { applies: false };
  }

  return current?.kind === 'deleted' && current.revision === command.baseRevision
    ? { applies: true, kind: 'automatic', recipeId: command.recipeId }
    : { applies: false };
};
