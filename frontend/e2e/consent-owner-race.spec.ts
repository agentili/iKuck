import { expect, test, type Page, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

type PrincipalKey = 'owner-a' | 'owner-b';

type FakePrincipal = {
  key: PrincipalKey;
  userId: string;
  email: string;
  csrfToken: string;
  sessionCookie: string;
};

type ConsentRequestRecord = {
  method: string;
  principal: PrincipalKey;
  sessionCookie: string;
  csrfToken: string | undefined;
  body?: unknown;
};

type HarnessSnapshot = {
  userId: string | null;
  csrfToken: string | null;
  scope: string;
  scopeError: string | null;
  profileMounts: number;
  profileUnmounts: number;
  consentMounts: number;
  consentUnmounts: number;
};

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
let devServer: ViteDevServer | undefined;
let devOrigin = '';

const isConsentRaceHarness = (): boolean => {
  const target = window as Window & { __ikuckConsentRace?: { ready: boolean } };
  return target.__ikuckConsentRace?.ready === true;
};

test.beforeAll(async () => {
  devServer = await createServer({
    root: frontendRoot,
    configFile: `${frontendRoot}/vite.config.ts`,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await devServer.listen();
  const address = devServer.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('The test-only Vite server did not expose a TCP address');
  }
  devOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await devServer?.close();
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

const readSessionCookie = (cookieHeader: string | undefined): string | null => {
  const match = cookieHeader?.match(/(?:^|;\s*)ikuck_session=([^;]+)/);
  return match?.[1] ?? null;
};

const sessionPayload = (principal: FakePrincipal) => ({
  authenticated: true,
  user: {
    id: principal.userId,
    email: principal.email,
    emailVerifiedAt: '2026-11-01T09:00:00.000Z',
  },
  csrfToken: principal.csrfToken,
  expiresAt: '2027-11-01T09:00:00.000Z',
});

const cookieHeader = (principal: FakePrincipal): string => (
  `ikuck_session=${principal.sessionCookie}; Path=/; HttpOnly; SameSite=Lax`
);

const fakeCredential = (kind: 'csrf' | 'session', principal: PrincipalKey): string => `e2e-only-${principal}-${kind}`;

const statusFor = (principal: FakePrincipal) => principal.key === 'owner-a'
  ? {
    consent: { enabled: false, updatedAt: '2026-11-16T12:00:00.000Z' },
    selectedProvider: 'openai',
    selectedImageProvider: 'openai',
  }
  : {
    consent: {
      enabled: true,
      homeProvider: 'gemini',
      imageProvider: 'openai',
      imagePolicyVersion: 'recipe-images-v3',
      updatedAt: '2026-11-16T12:03:00.000Z',
    },
    selectedProvider: 'gemini',
    selectedImageProvider: 'openai',
  };

const getHarnessSnapshot = async (page: Page): Promise<HarnessSnapshot | null> => page.evaluate(() => {
  const target = window as Window & { __ikuckConsentRace?: { snapshot: () => HarnessSnapshot } };
  return target.__ikuckConsentRace?.snapshot() ?? null;
});

for (const permission of ['home', 'images'] as const) {
  test(`browser integration rejects a stale ${permission} consent refresh after an in-place owner switch`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await context.clearCookies();

    const loginPassword = `e2e-only-${Date.now()}`;
    const ownerA: FakePrincipal = {
      key: 'owner-a',
      userId: 'consent-race-owner-a',
      email: 'owner-a@example.test',
      csrfToken: fakeCredential('csrf', 'owner-a'),
      sessionCookie: fakeCredential('session', 'owner-a'),
    };
    const ownerB: FakePrincipal = {
      key: 'owner-b',
      userId: 'consent-race-owner-b',
      email: 'owner-b@example.test',
      csrfToken: fakeCredential('csrf', 'owner-b'),
      sessionCookie: fakeCredential('session', 'owner-b'),
    };
    const principalByCookie = new Map<string, FakePrincipal>([
      [ownerA.sessionCookie, ownerA],
      [ownerB.sessionCookie, ownerB],
    ]);
    const consentRequests: ConsentRequestRecord[] = [];
    const houseReads: Array<{ principal: PrincipalKey; sessionCookie: string }> = [];
    const loginPrincipals: PrincipalKey[] = [];
    const logoutRequests: ConsentRequestRecord[] = [];
    const externalRequests: string[] = [];
    let conflictRefreshArmed = false;
    let staleRefreshCaptured = false;
    let staleRefreshRecord: ConsentRequestRecord | undefined;
    let releaseStaleRefresh: (() => void) | undefined;
    let signalStaleRefreshStarted!: () => void;
    let signalStaleRefreshFinished!: () => void;
    const staleRefreshStarted = new Promise<void>((resolve) => { signalStaleRefreshStarted = resolve; });
    const staleRefreshFinished = new Promise<void>((resolve) => { signalStaleRefreshFinished = resolve; });

    const principalFor = async (route: Route): Promise<{ principal: FakePrincipal; cookie: string; headers: Record<string, string> }> => {
      const headers = await route.request().allHeaders();
      const cookie = readSessionCookie(headers.cookie);
      const principal = cookie === null ? undefined : principalByCookie.get(cookie);
      if (principal === undefined || cookie === null) {
        throw new Error(`Missing recognized session cookie for ${route.request().method()} ${new URL(route.request().url()).pathname}`);
      }
      return { principal, cookie, headers };
    };

    await context.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== devOrigin) {
        externalRequests.push(`${route.request().method()} ${requestUrl.origin}${requestUrl.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await installOfflineBackend(page);

    await page.route('**/v1/auth/session', async (route) => {
      await route.fulfill({
        status: 200,
        json: sessionPayload(ownerA),
        headers: { 'set-cookie': cookieHeader(ownerA) },
      });
    });

    await page.route('**/v1/auth/login', async (route) => {
      const body = route.request().postDataJSON() as { email?: string; password?: string };
      expect(body).toEqual({ email: ownerB.email, password: loginPassword });
      loginPrincipals.push(ownerB.key);
      await route.fulfill({
        status: 200,
        json: sessionPayload(ownerB),
        headers: { 'set-cookie': cookieHeader(ownerB) },
      });
    });

    await page.route('**/v1/auth/logout', async (route) => {
      const { principal, cookie, headers } = await principalFor(route);
      const record: ConsentRequestRecord = {
        method: route.request().method(),
        principal: principal.key,
        sessionCookie: cookie,
        csrfToken: headers['x-csrf-token'],
      };
      logoutRequests.push(record);
      expect(principal.key).toBe(ownerA.key);
      expect(record.csrfToken).toBe(ownerA.csrfToken);
      await route.fulfill({
        status: 204,
        headers: { 'set-cookie': 'ikuck_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' },
      });
    });

    await page.route('**/v1/house', async (route) => {
      const { principal, cookie } = await principalFor(route);
      houseReads.push({ principal: principal.key, sessionCookie: cookie });
      await route.fulfill({ status: 200, json: null });
    });

    await page.route('**/v1/profile', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const { principal } = await principalFor(route);
      await route.fulfill({ status: 200, json: { profile: { displayName: principal.key } } });
    });

    await page.route('**/v1/ai-recipes/consent', async (route) => {
      const method = route.request().method();
      const { principal, cookie, headers } = await principalFor(route);
      if (method === 'GET') {
        const record: ConsentRequestRecord = {
          method,
          principal: principal.key,
          sessionCookie: cookie,
          csrfToken: headers['x-csrf-token'],
        };
        consentRequests.push(record);
        if (principal.key === ownerA.key && conflictRefreshArmed && !staleRefreshCaptured) {
          staleRefreshCaptured = true;
          staleRefreshRecord = record;
          signalStaleRefreshStarted();
          await new Promise<void>((resolve) => { releaseStaleRefresh = resolve; });
          try {
            await route.abort('failed');
          } finally {
            signalStaleRefreshFinished();
          }
          return;
        }
        await route.fulfill({ status: 200, json: statusFor(principal) });
        return;
      }
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as unknown;
        const record: ConsentRequestRecord = {
          method,
          principal: principal.key,
          sessionCookie: cookie,
          csrfToken: headers['x-csrf-token'],
          body,
        };
        consentRequests.push(record);
        expect(principal.key).toBe(ownerA.key);
        expect(record.csrfToken).toBe(ownerA.csrfToken);
        conflictRefreshArmed = true;
        await route.fulfill({
          status: 409,
          json: { code: 'ai_consent_revision_conflict', message: 'Consent revision changed' },
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${devOrigin}/e2e/fixtures/consent-owner-race.html`);
    const profile = page.getByTestId('profile-page');
    const raceSettings = page.getByTestId('consent-race-settings');
    await expect(profile.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
    await page.waitForFunction(isConsentRaceHarness);
    await expect(raceSettings.getByText('Provider selezionato dal server: OpenAI.')).toBeVisible();
    await expect.poll(() => consentRequests.filter((request) => request.method === 'GET' && request.principal === ownerA.key).length).toBe(2);

    const ownerAHomeCheckbox = raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a OpenAI dei dati necessari per creare ricette AI',
    });
    const ownerAImagesCheckbox = raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a OpenAI per le immagini delle ricette',
    });
    if (permission === 'home') {
      await expect(ownerAHomeCheckbox).not.toBeChecked();
      await ownerAHomeCheckbox.check();
      await raceSettings.getByRole('button', { name: 'Salva consenso AI' }).click();
    } else {
      await expect(ownerAImagesCheckbox).not.toBeChecked();
      await ownerAImagesCheckbox.check();
      await raceSettings.getByRole('button', { name: 'Salva consenso immagini AI' }).click();
    }
    await staleRefreshStarted;
    expect(staleRefreshRecord).toMatchObject({ principal: ownerA.key, sessionCookie: ownerA.sessionCookie });

    const consentNode = raceSettings.locator('#ai-consent-settings');
    await consentNode.evaluate((element) => {
      (window as Window & { __ikuckConsentRaceConsentNode?: Element }).__ikuckConsentRaceConsentNode = element;
    });
    const profileExit = profile.getByRole('button', { name: 'Esci', exact: true });
    await profileExit.click();
    const account = profile.getByRole('region', { name: 'Account' });
    await account.getByRole('button', { name: 'Accedi o registrati' }).click();
    await account.getByRole('button', { name: 'Accedi', exact: true }).click();
    await account.getByLabel('Email', { exact: true }).fill(ownerB.email);
    await account.getByLabel('Password', { exact: true }).fill(loginPassword);
    await account.getByRole('button', { name: 'Accedi al profilo' }).click();
    await expect(profile.getByText(ownerB.email, { exact: true })).toBeVisible();
    await page.waitForFunction(({ userId, csrfToken, scope }) => {
      const target = window as Window & { __ikuckConsentRace?: { snapshot: () => HarnessSnapshot } };
      const snapshot = target.__ikuckConsentRace?.snapshot();
      return snapshot?.userId === userId && snapshot.csrfToken === csrfToken && snapshot.scope === scope && snapshot.scopeError === null;
    }, { userId: ownerB.userId, csrfToken: ownerB.csrfToken, scope: `account:${ownerB.userId}` });

    await expect(raceSettings.getByText('Provider selezionato dal server: Gemini di Google.')).toBeVisible();
    await expect(raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a Gemini di Google dei dati necessari per creare ricette AI',
    })).toBeChecked();
    await expect(raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a OpenAI per le immagini delle ricette',
    })).toBeChecked();
    await expect(raceSettings.getByText('Consenso immagini attivo per OpenAI.')).toBeVisible();
    await expect(raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a OpenAI dei dati necessari per creare ricette AI',
    })).toHaveCount(0);
    await expect(raceSettings.getByRole('checkbox', {
      name: 'Acconsento all’invio a Gemini di Google per le immagini delle ricette',
    })).toHaveCount(0);

    const snapshot = await getHarnessSnapshot(page);
    expect(snapshot).toMatchObject({
      userId: ownerB.userId,
      csrfToken: ownerB.csrfToken,
      scope: `account:${ownerB.userId}`,
      profileMounts: 1,
      profileUnmounts: 0,
      consentMounts: 1,
      consentUnmounts: 0,
      scopeError: null,
    });
    expect(await consentNode.evaluate((element) => {
      const target = window as Window & { __ikuckConsentRaceConsentNode?: Element };
      return target.__ikuckConsentRaceConsentNode === element;
    })).toBe(true);
    expect(loginPrincipals).toEqual([ownerB.key]);
    expect(logoutRequests).toEqual([{
      method: 'POST',
      principal: ownerA.key,
      sessionCookie: ownerA.sessionCookie,
      csrfToken: ownerA.csrfToken,
    }]);
    expect(houseReads).toContainEqual({ principal: ownerA.key, sessionCookie: ownerA.sessionCookie });
    expect(houseReads).toContainEqual({ principal: ownerB.key, sessionCookie: ownerB.sessionCookie });
    expect(consentRequests.some((request) => request.method === 'GET' && request.principal === ownerB.key && request.sessionCookie === ownerB.sessionCookie)).toBe(true);
    expect(externalRequests).toEqual([]);

    if (releaseStaleRefresh === undefined) throw new Error('The stale consent refresh was not held');
    releaseStaleRefresh();
    await staleRefreshFinished;
    await expect(raceSettings.getByRole('alert')).toHaveCount(0);
    await expect(raceSettings.getByText(/Il consenso è cambiato/i)).toHaveCount(0);
    await expect(raceSettings.getByText('Consenso attivo per OpenAI.')).toHaveCount(0);
    await expect(raceSettings.getByText(/Consenso immagini attivo per OpenAI/)).toBeVisible();

    const grantWrites = consentRequests.filter((request) => request.method === 'PUT');
    expect(grantWrites).toHaveLength(1);
    expect(grantWrites[0]).toMatchObject({
      principal: ownerA.key,
      sessionCookie: ownerA.sessionCookie,
      csrfToken: ownerA.csrfToken,
      body: permission === 'home'
        ? { enabled: true, homeProvider: 'openai', expectedRevision: '2026-11-16T12:00:00.000Z' }
        : { enabled: true, imagePolicyVersion: 'recipe-images-v3', imageProvider: 'openai', expectedRevision: '2026-11-16T12:00:00.000Z' },
    });
    expect(staleRefreshRecord).toMatchObject({
      method: 'GET',
      principal: ownerA.key,
      sessionCookie: ownerA.sessionCookie,
      csrfToken: undefined,
    });
    expect(consentRequests.filter((request) => request.method === 'PUT' && request.principal === ownerB.key)).toHaveLength(0);
  });
}
