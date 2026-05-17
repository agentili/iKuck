import { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/connection';
import { hashPassword, comparePassword } from '../utils/password';
import { signToken } from '../utils/jwt';
import { logger } from '../utils/logger';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  username: z.string().min(3),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const register = async (req: Request, res: Response) => {
  try {
    const validated = registerSchema.parse(req.body);
    const { email, password, username } = validated;

    // Check if user exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rowCount && existingUser.rowCount > 0) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    const passwordHash = await hashPassword(password);

    // Use transaction if possible, but for simplicity:
    const newUser = await query(
      'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username',
      [email, username, passwordHash]
    );

    const userId = newUser.rows[0].id;

    // Create empty pantry for the user
    await query('INSERT INTO pantries (user_id) VALUES ($1)', [userId]);

    const token = signToken(userId);

    res.status(201).json({
      success: true,
      data: {
        userId,
        email: newUser.rows[0].email,
        username: newUser.rows[0].username,
        token,
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Registration error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const validated = loginSchema.parse(req.body);
    const { email, password } = validated;

    const userResult = await query(
      'SELECT id, email, username, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (!userResult.rowCount || userResult.rowCount === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const isMatch = await comparePassword(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = signToken(user.id);

    res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        username: user.username,
        token,
      },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: err.errors });
    }
    logger.error('Login error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
