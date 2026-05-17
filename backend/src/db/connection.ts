import { Pool } from 'pg';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

// Test connection
pool.query('SELECT 1')
  .then(() => logger.info('Database connected successfully'))
  .catch((err) => logger.error('Database connection error', err));

export default pool;
