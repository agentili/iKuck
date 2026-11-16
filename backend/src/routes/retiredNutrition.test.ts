import { expect, it } from 'vitest';
import { createApp } from '../app.js';

it('does not register the retired remote nutrition endpoint', async () => {
  const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/recipes/nutrition', payload: { ingredients: [{ query: 'pasta', grams: 100 }] } });
    expect(response.statusCode).toBe(404);
    expect(app.hasRoute({ method: 'POST', url: '/v1/recipes/nutrition' })).toBe(false);
  } finally { await app.close(); }
});
