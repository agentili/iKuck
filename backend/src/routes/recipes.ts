import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getSuggestions, addHistory, updateRating, getHistory } from '../controllers/recipeController';

const router = Router();

router.use(authenticateToken);

router.get('/suggest', getSuggestions);
router.post('/history', addHistory);
router.put('/history/:historyId', updateRating);
router.get('/history', getHistory);

export default router;
