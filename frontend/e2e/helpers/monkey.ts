import type { Page } from '@playwright/test';

interface MonkeyOptions {
  iterations?: number;
  startUrl?: string;
}

interface MonkeyReport {
  iterations: number;
  startUrl: string;
  visitedUrls: string[];
  jsErrors: string[];
  networkErrors: string[];
  finalUrl: string;
  stoppedEarly?: boolean;
}

/**
 * Intercetta tutte le chiamate API /v1/** rispondendo con HTTP 200 e payload vuoto,
 * senza lanciare errori su richieste inaspettate. Ideale per esplorazione casuale
 * dove non si conoscono a priori tutti gli endpoint chiamati.
 */
export async function installPermissiveBackend(page: Page): Promise<void> {
  await page.route('**/v1/**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ status: 200, json: null });
      return;
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      await route.fulfill({ status: 200, json: { accepted: true } });
      return;
    }
    await route.fulfill({ status: 200, json: null });
  });
}

const isInternalLink = (href: string | null): boolean => {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://')) return false;
  if (href.startsWith('#')) return false; // ancor di pagina: non navigazione reale
  if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return false;
  return true;
};

/**
 * Esplorazione casuale (monkey testing): parte da startUrl, poi per N iterazioni
 * seleziona a caso un link interno o un bottone visibile, ci clicca sopra e attende
 * la stabilizzazione della pagina. Raccoglie URL visitati, errori JS non gestiti
 * ed errori di rete. Se la pagina si chiude o diventa inutilizzabile, si ferma graceful.
 */
export async function monkeyExplore(page: Page, options: MonkeyOptions = {}): Promise<MonkeyReport> {
  const iterations = options.iterations ?? 50;
  const startUrl = options.startUrl ?? '/';
  const visitedUrls: string[] = [];
  const jsErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText;
    if (failure && /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(failure)) {
      networkErrors.push(`${request.method()} ${request.url()}: ${failure}`);
    }
  });

  let stoppedEarly = false;

  try {
    await page.goto(startUrl);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    visitedUrls.push(page.url());

    for (let i = 0; i < iterations; i += 1) {
      if (page.isClosed() === true) {
        stoppedEarly = true;
        break;
      }

      let clickable: Array<ReturnType<Page['locator']>> = [];
      try {
        const links = await page.getByRole('link').all();
        const buttons = await page.getByRole('button').all();

        const visibleLocators: Array<ReturnType<Page['locator']>> = [];
        for (const loc of [...links, ...buttons]) {
          try {
            if (await loc.isVisible()) {
              const isLink = (await loc.evaluate((el) => el.tagName === 'A')) ?? false;
              if (isLink) {
                const href = await loc.getAttribute('href');
                if (!isInternalLink(href)) continue;
              } else {
                // Bottone: salta se disabilitato
                const isEnabled = await loc.isEnabled().catch(() => false);
                if (!isEnabled) continue;
              }
              visibleLocators.push(loc);
            }
          } catch {
            // Elemento staccato dal DOM: ignorato
          }
        }
        clickable = visibleLocators;
      } catch {
        stoppedEarly = true;
        break;
      }

      if (clickable.length === 0) {
        stoppedEarly = true;
        break;
      }

      const target = clickable[Math.floor(Math.random() * clickable.length)];
      const beforeUrl = page.url();
      try {
        // force: true supera overlay/dialog che intercettano i puntatori;
        // timeout breve evita di bloccare l'intero test su un elemento bloccato.
        await target.click({ timeout: 5000, force: true });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      } catch (err) {
        jsErrors.push(`click error at iteration ${i}: ${(err as Error).message}`);
        continue;
      }

      if (page.isClosed() === true) {
        stoppedEarly = true;
        break;
      }

      const afterUrl = page.url();
      if (afterUrl !== beforeUrl) {
        visitedUrls.push(afterUrl);
      }
    }
  } catch (err) {
    jsErrors.push(`monkey fatal error: ${(err as Error).message}`);
    stoppedEarly = true;
  }

  return {
    iterations,
    startUrl,
    visitedUrls,
    jsErrors,
    networkErrors,
    finalUrl: page.isClosed() === true ? startUrl : page.url(),
    stoppedEarly,
  };
}
