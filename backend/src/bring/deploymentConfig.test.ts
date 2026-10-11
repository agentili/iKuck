import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const apiEnvironment = (compose: string) => {
  const lines = compose.split(/\r?\n/);
  const apiIndex = lines.indexOf('  api:');
  const environmentIndex = lines.findIndex((line, index) => index > apiIndex && line === '    environment:');
  if (apiIndex < 0 || environmentIndex < 0) throw new Error('Compose API environment is missing');
  const environmentEnd = lines.findIndex((line, index) => index > environmentIndex && /^(?: {0,5}\S)/.test(line));
  return lines.slice(environmentIndex + 1, environmentEnd < 0 ? undefined : environmentEnd).join('\n');
};

describe('Bring deployment configuration', () => {
  it('forwards only server-side Bring settings to the disabled-by-default API service', () => {
    for (const path of ['../../../deploy/docker-compose.standalone.yml', '../../../deploy/docker-compose.production.yml']) {
      const compose = readProjectFile(path);
      const environment = apiEnvironment(compose);

      expect(environment).toMatch(/^ {6}BRING_ENABLED: \$\{BRING_ENABLED:-false\}$/m);
      expect(environment).toMatch(/^ {6}BRING_TOKEN_ENCRYPTION_KEY: \$\{BRING_TOKEN_ENCRYPTION_KEY:-\}$/m);
      expect(environment).toMatch(/^ {6}BRING_TEST_LIST_ID: \$\{BRING_TEST_LIST_ID:-\}$/m);
      expect(compose.match(/^ {6}BRING_ENABLED:/gm)).toHaveLength(1);
      expect(compose.match(/^ {6}BRING_TOKEN_ENCRYPTION_KEY:/gm)).toHaveLength(1);
      expect(compose.match(/^ {6}BRING_TEST_LIST_ID:/gm)).toHaveLength(1);
      expect(compose).not.toMatch(/VITE_BRING_[A-Z0-9_]+/);
    }
  });

  it('documents opt-in and a 32-byte hexadecimal server key in every existing environment example', () => {
    for (const path of ['../../.env.example', '../../../deploy/.env.standalone.example', '../../../deploy/.env.example']) {
      const example = readProjectFile(path);

      expect(example).toMatch(/^BRING_ENABLED=false$/m);
      expect(example).toMatch(/^BRING_TOKEN_ENCRYPTION_KEY=$/m);
      expect(example).toMatch(/^BRING_TEST_LIST_ID=$/m);
      expect(example).toMatch(/^# Generate 32 random bytes and encode them as 64 hexadecimal characters\.$/m);
      expect(example).not.toMatch(/VITE_BRING_[A-Z0-9_]+/);
    }
  });
});
