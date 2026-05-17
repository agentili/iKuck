import { query } from '../db/connection';
import { PantryItem } from '../types';

export const getPantryIdForUser = async (userId: string): Promise<string | null> => {
  const result = await query('SELECT id FROM pantries WHERE user_id = $1', [userId]);
  return result.rowCount && result.rowCount > 0 ? result.rows[0].id : null;
};

export const getPantry = async (userId: string): Promise<PantryItem[]> => {
  const pantryId = await getPantryIdForUser(userId);
  if (!pantryId) return [];

  const result = await query(
    'SELECT * FROM pantry_items WHERE pantry_id = $1 ORDER BY added_at DESC',
    [pantryId]
  );
  return result.rows;
};

export const addItem = async (pantryId: string, item: Partial<PantryItem>): Promise<PantryItem> => {
  const result = await query(
    'INSERT INTO pantry_items (pantry_id, name, category, quantity, unit, expiry_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [pantryId, item.name, item.category, item.quantity, item.unit, item.expiry_date]
  );
  return result.rows[0];
};

export const updateItem = async (pantryId: string, itemId: string, data: Partial<PantryItem>): Promise<PantryItem | null> => {
  const result = await query(
    'UPDATE pantry_items SET name = COALESCE($1, name), category = COALESCE($2, category), quantity = COALESCE($3, quantity), unit = COALESCE($4, unit), expiry_date = COALESCE($5, expiry_date), updated_at = CURRENT_TIMESTAMP WHERE id = $6 AND pantry_id = $7 RETURNING *',
    [data.name, data.category, data.quantity, data.unit, data.expiry_date, itemId, pantryId]
  );
  return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
};

export const deleteItem = async (pantryId: string, itemId: string): Promise<boolean> => {
  const result = await query(
    'DELETE FROM pantry_items WHERE id = $1 AND pantry_id = $2',
    [itemId, pantryId]
  );
  return result.rowCount !== null && result.rowCount > 0;
};
