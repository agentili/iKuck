import { query } from '../db/connection';
import { RecipeHistory } from '../types';

export const addHistory = async (userId: string, recipeId: string, mealType: string, completedDate: string) => {
  const result = await query(
    'INSERT INTO recipe_history (user_id, recipe_id, meal_type, completed_date) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, recipeId, mealType, completedDate]
  );
  return result.rows[0];
};

export const updateRating = async (historyId: string, userId: string, rating: number, notes?: string) => {
  const result = await query(
    'UPDATE recipe_history SET rating = $1, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND user_id = $4 RETURNING *',
    [rating, notes, historyId, userId]
  );
  return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
};

export const getUserHistory = async (userId: string): Promise<RecipeHistory[]> => {
  const result = await query(
    'SELECT h.*, r.title, r.difficulty, r.preparation_time FROM recipe_history h JOIN recipes r ON h.recipe_id = r.id WHERE h.user_id = $1 ORDER BY h.completed_date DESC',
    [userId]
  );
  return result.rows;
};
