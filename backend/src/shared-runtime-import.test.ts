import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('shared runtime module imports', () => {
  it('loads the dinner diary export with Node 24 type stripping', () => {
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "await import('@ikuck/shared/dinnerDiary'); console.log('runtime-import-ok');",
    ], { cwd: backendRoot, encoding: 'utf8' });

    expect(output.trim()).toBe('runtime-import-ok');
  });
});
