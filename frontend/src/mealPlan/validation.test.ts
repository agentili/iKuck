import { describe, expect, it } from 'vitest';
import type { PlanCommand, PlanState } from '@ikuck/shared/contracts';
import { isPlanCommand, isPlanState, parseMealPlanReadResponse } from './validation';

const state: PlanState = {
  date: '2026-10-29', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 1,
  kind: 'manual', recipeId: 'pollo-al-limone',
};
const command: PlanCommand = {
  version: 2, scope: 'house:house-1', date: state.date, operationId: 'op-1', deviceId: 'device-1',
  clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set', recipeId: 'pollo-al-limone',
};

describe('meal plan payload validation', () => {
  it('accepts only a valid v2 command and state', () => {
    expect(isPlanCommand(command)).toBe(true);
    expect(isPlanState(state)).toBe(true);
  });

  it('rejects an invalid command version, impossible date, or extra fields', () => {
    expect(isPlanCommand({ ...command, version: 1 })).toBe(false);
    expect(isPlanCommand({ ...command, date: '2026-02-30' })).toBe(false);
    expect(isPlanCommand({ ...command, unexpected: true })).toBe(false);
  });

  it('accepts a complete read response and rejects missing, duplicate or off-date states', () => {
    const response = { version: 2, states: [{ date: state.date, state }] };
    expect(parseMealPlanReadResponse(response, [state.date])).toEqual(response);
    expect(parseMealPlanReadResponse({ version: 2, states: [] }, [state.date])).toBeNull();
    expect(parseMealPlanReadResponse({ version: 2, states: [response.states[0], response.states[0]] }, [state.date])).toBeNull();
    expect(parseMealPlanReadResponse({ version: 2, states: [{ date: state.date, state: { ...state, date: '2026-10-30' } }] }, [state.date])).toBeNull();
  });
});
