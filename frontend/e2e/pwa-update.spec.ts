import { createServer, type Server } from 'node:http';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { installOfflineBackend } from './helpers/backendMode';

const buildRoot = resolve('.pwa-test');
const buildA = join(buildRoot, 'build-a');
const buildB = join(buildRoot, 'build-b');

const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

interface PwaServer {
  url: string;
  swapToBuildB: () => Promise<void>;
  close: () => Promise<void>;
}

const runBuild = async (outputDirectory: string, buildId: string): Promise<void> => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCommand, ['run', 'build', '--', '--outDir', outputDirectory], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_BUILD_ID: buildId },
    shell: process.platform === 'win32',
    stdio: 'pipe',
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const result = await new Promise<{ code: number | null }>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code }));
  });
  if (result.code !== 0) throw new Error(`PWA build ${buildId} failed:\n${output}`);
};

const createPwaServer = async (): Promise<PwaServer> => {
  const serverRoot = buildA;
  const server: Server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const requestedFile = join(serverRoot, relativePath);
    let filePath = requestedFile;
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw new Error('not a file');
    } catch {
      if (extname(pathname) !== '') {
        response.writeHead(404);
        response.end();
        return;
      }
      filePath = join(serverRoot, 'index.html');
    }

    response.writeHead(200, {
      'cache-control': pathname === '/sw.js' ? 'no-cache' : 'no-store',
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('PWA test server did not expose a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    swapToBuildB: async () => {
      await rm(serverRoot, { recursive: true, force: true });
      await cp(buildB, serverRoot, { recursive: true });
    },
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
    },
  };
};

let pwaServer: PwaServer;

test.beforeAll(async () => {
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await runBuild(buildA, 'build-a');
  await runBuild(buildB, 'build-b');
  pwaServer = await createPwaServer();
});

test.afterAll(async () => {
  if (pwaServer !== undefined) await pwaServer.close();
  await rm(buildRoot, { recursive: true, force: true });
});

test('updates the service worker without losing IndexedDB data', async ({ page, context }) => {
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': {
        json: {
          authenticated: true,
          user: { id: 'pwa-user', email: 'pwa@example.com', emailVerifiedAt: '2026-09-15T08:00:00.000Z' },
          csrfToken: 'pwa-csrf',
          expiresAt: '2026-10-15T08:00:00.000Z',
        },
      },
      'GET /v1/profile': { json: { profile: { displayName: 'PWA' } } },
      'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
      'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: null } } },
      'GET /v1/ai-recipes': { json: { recipes: [] } },
    },
  });

  await page.goto(`${pwaServer.url}/`);
  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await page.getByLabel('Ingredienti presenti').fill('pasta, pomodoro');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);

  await page.goto(`${pwaServer.url}/profile`);
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  await page.getByText('Diagnostica applicazione').click();
  await expect(page.getByText('build-a', { exact: true })).toBeVisible();

  await pwaServer.swapToBuildB();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

  await expect(page.getByText('Aggiornamento disponibile')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  await page.getByRole('button', { name: 'Aggiorna ora' }).click();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  await page.getByText('Diagnostica applicazione').click();
  await expect(page.getByText('build-b', { exact: true })).toBeVisible();

  await page.goto(`${pwaServer.url}/`);
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await context.setOffline(false);
});
