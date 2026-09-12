import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDockerConfigs: string[] = [];
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';

const readComposeConfig = (relativePath: string) => {
  const dockerConfig = mkdtempSync(join(tmpdir(), 'ikuck-docker-'));
  temporaryDockerConfigs.push(dockerConfig);
  const output = execFileSync(
    dockerCommand,
    ['--config', dockerConfig, 'compose', '-f', resolve(process.cwd(), '..', relativePath), 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DOMAIN: 'ikuck.example',
        POSTGRES_DB: 'ikuck',
        POSTGRES_PASSWORD: 'test-postgres-password',
        POSTGRES_USER: 'ikuck',
        SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
      },
    },
  );

  return JSON.parse(output) as {
    services: Record<string, { ports?: Array<{ target: number; published?: string }> }>;
  };
};

afterEach(() => {
  temporaryDockerConfigs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe('deployment contracts', () => {
  it('keeps PostgreSQL and Redis off the public network in development', () => {
    const compose = readComposeConfig('compose.dev.yml');

    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services.redis.ports).toBeUndefined();
    expect(compose.services.api.ports).toEqual([
      expect.objectContaining({ target: 3000, published: '3000' }),
    ]);
  });

  it('exposes only HTTP and HTTPS from the production composition', () => {
    const compose = readComposeConfig('deploy/docker-compose.production.yml');

    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services.redis.ports).toBeUndefined();
    expect(compose.services.caddy.ports).toEqual([
      expect.objectContaining({ target: 80, published: '80' }),
      expect.objectContaining({ target: 443, published: '443' }),
    ]);
  });
});
