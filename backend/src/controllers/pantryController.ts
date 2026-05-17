import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import * as pantryService from '../services/pantryService';
import { logger } from '../utils/logger';

const itemSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  category: z.string().optional(),
  expiry_date: z.string().optional(),
});

const updateItemSchema = itemSchema.partial();

export const getPantry = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const items = await pantryService.getPantry(userId);
    res.status(200).json({ success: true, data: items });
  } catch (err) {
    logger.error('Get pantry error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const addItem = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const validated = itemSchema.parse(req.body);
    const pantryId = await pantryService.getPantryIdForUser(userId);

    if (!pantryId) {
      return res.status(404).json({ success: false, error: 'Pantry not found' });
    }

    const newItem = await pantryService.addItem(pantryId, validated);
    res.status(201).json({ success: true, data: newItem });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Add pantry item error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const updateItem = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { itemId } = req.params;
    const validated = updateItemSchema.parse(req.body);
    const pantryId = await pantryService.getPantryIdForUser(userId);

    if (!pantryId) {
      return res.status(404).json({ success: false, error: 'Pantry not found' });
    }

    const updated = await pantryService.updateItem(pantryId, itemId, validated);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Update pantry item error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const deleteItem = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { itemId } = req.params;
    const pantryId = await pantryService.getPantryIdForUser(userId);

    if (!pantryId) {
      return res.status(404).json({ success: false, error: 'Pantry not found' });
    }

    const success = await pantryService.deleteItem(pantryId, itemId);
    if (!success) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    res.status(204).send();
  } catch (err) {
    logger.error('Delete pantry item error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
