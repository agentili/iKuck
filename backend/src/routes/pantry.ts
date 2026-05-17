import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getPantry, addItem, updateItem, deleteItem } from '../controllers/pantryController';

const router = Router();

router.use(authenticateToken);

router.get('/', getPantry);
router.post('/items', addItem);
router.put('/items/:itemId', updateItem);
router.delete('/items/:itemId', deleteItem);

export default router;
