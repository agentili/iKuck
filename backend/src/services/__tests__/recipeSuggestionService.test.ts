import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as suggestionService from '../recipeSuggestionService';
import * as pantryService from '../pantryService';
import { query } from '../../db/connection';

vi.mock('../pantryService');
vi.mock('../../db/connection');

describe('RecipeSuggestionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Given pantry with matching ingredients, When suggest is called, Then returns viable recipes', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([
      { name: 'pomodoro', quantity: 10 } as any,
      { name: 'pasta', quantity: 500 } as any
    ]);

    vi.mocked(query).mockImplementation((text: string, params?: any[]) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [
            { id: '1', title: 'R1', ingredients: [{ name: 'pomodoro', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 },
            { id: '2', title: 'R2', ingredients: [{ name: 'pasta', quantity: 100, isOptional: false }], difficulty: 'easy', preparation_time: 20 },
            { id: '3', title: 'R3', ingredients: [{ name: 'pomodoro', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 },
          ]
        } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result.length).toBe(3);
  });

  it('Given no history, When suggest is called, Then all suggestions are new recipes', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([{ name: 'pomodoro', quantity: 10 }] as any);
    vi.mocked(query).mockImplementation((text: string) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [{ id: '1', title: 'R1', ingredients: [{ name: 'pomodoro', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 }]
        } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result[0].wasExecuted).toBe(false);
  });

  it('Given 1 executed recipe matching pantry, When suggest is called, Then first suggestion is the executed recipe', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([{ name: 'pomodoro', quantity: 10 }] as any);
    vi.mocked(query).mockImplementation((text: string) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [
            { id: '1', title: 'R1', ingredients: [{ name: 'pomodoro', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 },
            { id: '2', title: 'R2', ingredients: [{ name: 'pomodoro', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 },
          ]
        } as any);
      }
      if (text.includes('SELECT recipe_id FROM recipe_history')) {
        return Promise.resolve({ rows: [{ recipe_id: '1' }] } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result[0].id).toBe('1');
    expect(result[0].wasExecuted).toBe(true);
  });

  it('Given ingredients match only 80%, When suggest is called, Then recipe is excluded', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([{ name: 'ing1', quantity: 10 }] as any);
    vi.mocked(query).mockImplementation((text: string) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [
            {
              id: '1',
              title: 'R1',
              ingredients: [
                { name: 'ing1', quantity: 1, isOptional: false },
                { name: 'ing2', quantity: 1, isOptional: false },
                { name: 'ing3', quantity: 1, isOptional: false },
                { name: 'ing4', quantity: 1, isOptional: false },
                { name: 'ing5', quantity: 1, isOptional: false },
              ],
              difficulty: 'easy',
              preparation_time: 20
            }
          ]
        } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result.length).toBe(0); // 1/5 = 20% match
  });

  it('Given empty pantry, When suggest is called, Then returns empty array', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([]);
    vi.mocked(query).mockImplementation((text: string) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [{ id: '1', title: 'R1', ingredients: [{ name: 'ing1', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 }]
        } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result.length).toBe(0);
  });

  it('Given all recipes already executed, When suggest is called, Then returns executed recipes', async () => {
    vi.mocked(pantryService.getPantry).mockResolvedValue([{ name: 'ing1', quantity: 10 }] as any);
    vi.mocked(query).mockImplementation((text: string) => {
      if (text.includes('SELECT * FROM recipes')) {
        return Promise.resolve({
          rows: [{ id: '1', title: 'R1', ingredients: [{ name: 'ing1', quantity: 1, isOptional: false }], difficulty: 'easy', preparation_time: 20 }]
        } as any);
      }
      if (text.includes('SELECT recipe_id FROM recipe_history')) {
        return Promise.resolve({ rows: [{ recipe_id: '1' }] } as any);
      }
      return Promise.resolve({ rows: [] } as any);
    });

    const result = await suggestionService.suggest('user1');
    expect(result.length).toBe(1);
    expect(result[0].wasExecuted).toBe(true);
  });
});
