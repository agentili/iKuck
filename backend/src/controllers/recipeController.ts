import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../middleware/auth';
import * as suggestionService from '../services/recipeSuggestionService';
import * as historyService from '../services/recipeHistoryService';
import { logger } from '../utils/logger';

const historySchema = z.object({
  recipeId: z.string(),
  mealType: z.enum(['breakfast', 'lunch', 'dinner']),
  completedDate: z.string(),
});

const ratingSchema = z.object({
  rating: z.number().min(1).max(5),
  notes: z.string().optional(),
});

export const getSuggestions = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const mealType = (req.query.mealType as string) || 'dinner';
    const suggestions = await suggestionService.suggest(userId, mealType);
    res.status(200).json({ success: true, data: { suggestions } });
  } catch (err) {
    logger.error('Get suggestions error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const addHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const validated = historySchema.parse(req.body);
    const history = await historyService.addHistory(
      userId,
      validated.recipeId,
      validated.mealType,
      validated.completedDate
    );
    res.status(201).json({ success: true, data: history });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Add history error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const updateRating = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { historyId } = req.params;
    const validated = ratingSchema.parse(req.body);
    const updated = await historyService.updateRating(
      historyId,
      userId,
      validated.rating,
      validated.notes
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'History record not found' });
    }
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Update rating error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const history = await historyService.getUserHistory(userId);
    res.status(200).json({ success: true, data: history });
  } catch (err) {
    logger.error('Get history error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
