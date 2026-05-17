import Dexie, { Table } from 'dexie';
import { User, PantryItem, Recipe, RecipeHistory } from '../types';

export class MyDatabase extends Dexie {
  users!: Table<User>;
  pantryItems!: Table<PantryItem>;
  recipes!: Table<Recipe>;
  recipeHistory!: Table<RecipeHistory>;
  syncQueue!: Table<{
    id?: number;
    operation: string;
    endpoint: string;
    payload: any;
    createdAt: Date;
  }>;

  constructor() {
    super('MealPlannerDB');
    this.version(1).stores({
      users: '++id, id, email, username',
      pantryItems: '++id, id, pantry_id, name, category, quantity, unit, expiry_date, updated_at',
      recipes: '++id, id, title, difficulty, preparation_time',
      recipeHistory: '++id, id, user_id, recipe_id, meal_type, completed_date, rating',
      syncQueue: '++id, operation, endpoint, createdAt'
    });
  }
}

export const db = new MyDatabase();
