import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('S2S CLI production packaging', () => {
  it('runs the compiled CLI with production runtime dependencies only', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(packageJson.scripts['s2s-admin']).toBe('node --env-file-if-exists=.env dist/s2s/adminCli.js');
    expect(packageJson.dependencies).not.toHaveProperty('tsx');
    expect(packageJson.devDependencies).toHaveProperty('tsx');
    expect(dockerfile).toContain('RUN npm ci --omit=dev');
    expect(dockerfile).toContain('COPY --from=build /app/backend/dist ./dist');
  });
});
