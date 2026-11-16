import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps the removed remote nutrition service out of runtime configuration and deployment contracts', async () => {
  for (const file of [
    './config.ts', './server.ts', './app.ts', './providers/factory.ts', './providers/types.ts', './providers/unavailable.ts',
    '../.env.example', '../../deploy/.env.example', '../../compose.dev.yml',
    '../../deploy/docker-compose.production.yml', '../../deploy/docker-compose.standalone.yml',
    '../../scripts/validate-production-config.ps1', '../../scripts/validate-production-config.test.ps1',
    '../../README.md', '../../AGENTS.md', '../../docs/production-readiness.md',
  ]) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8');
    expect(content, file).not.toMatch(/usda|NutritionProvider|recipeNutrition/i);
  }
});
