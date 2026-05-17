import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { logger } from '../utils/logger';

export interface AuthRequest extends Request {
  userId?: string;
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch (err) {
    logger.error('Token verification failed', err);
    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
  }
};
