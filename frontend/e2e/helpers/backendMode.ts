import type { BrowserContext, Page, Request } from '@playwright/test';

interface OfflineBackendState {
  unexpectedRequests: string[];
  connectionRefused: string[];
  responses: Map<string, OfflineApiResponse>;
  serviceWorkers: 'block' | 'allow';
  attachedPages: WeakSet<Page>;
  primaryPage: Page;
  setup?: Promise<void>;
}

export interface OfflineApiResponse {
  status?: number;
  json: unknown;
}

export interface OfflineBackendOptions {
  responses?: Record<string, OfflineApiResponse>;
  serviceWorkers?: 'block' | 'allow';
}

const states = new WeakMap<BrowserContext, OfflineBackendState>();

const requestDescription = (method: string, url: string): string => {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname}${parsed.search} (${parsed.origin})`;
  } catch {
    return `${method} ${url}`;
  }
};

const includesConnectionRefused = (value: string | undefined): boolean => (
  value?.includes('ECONNREFUSED') === true
  || value?.includes('ERR_CONNECTION_REFUSED') === true
);

const blockServiceWorkerRegistration = (): void => {
  const nativeNavigator = window.navigator;
  Object.defineProperty(window, 'navigator', {
    configurable: true,
    value: new Proxy(nativeNavigator, {
      has(target, property) {
        return property === 'serviceWorker' ? false : Reflect.has(target, property);
      },
      get(target, property) {
        if (property === 'serviceWorker') return undefined;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
};

const contextOrigin = (request: Request): string | undefined => {
  try {
    return new URL(request.frame().url()).origin;
  } catch {
    return undefined;
  }
};

const trackPage = (page: Page, state: OfflineBackendState): void => {
  if (state.attachedPages.has(page)) return;
  state.attachedPages.add(page);

  page.on('console', (message) => {
    if (includesConnectionRefused(message.text())) state.connectionRefused.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText;
    if (includesConnectionRefused(failure)) {
      state.connectionRefused.push(requestDescription(request.method(), request.url()));
    }
  });
};

const installContextGuard = async (page: Page, state: OfflineBackendState): Promise<void> => {
  const context = page.context();
  for (const openPage of context.pages()) trackPage(openPage, state);
  context.on('page', (openPage) => trackPage(openPage, state));

  if (state.serviceWorkers === 'block') {
    await context.addInitScript(blockServiceWorkerRegistration);
  }

  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = requestDescription(request.method(), request.url());
    const primaryOrigin = (() => {
      try {
        return new URL(state.primaryPage.url()).origin;
      } catch {
        return undefined;
      }
    })();
    const isSameOrigin = primaryOrigin === url.origin && contextOrigin(request) === url.origin;
    const responseKey = `${request.method()} ${url.pathname}${url.search}`;
    const configuredResponse = isSameOrigin ? state.responses.get(responseKey) : undefined;

    if (configuredResponse !== undefined) {
      await route.fulfill({ status: configuredResponse.status ?? 200, json: configuredResponse.json });
      return;
    }

    state.unexpectedRequests.push(description);
    await route.abort('failed');
  });
};

export const installOfflineBackend = async (page: Page, options: OfflineBackendOptions = {}): Promise<void> => {
  const context = page.context();
  let state = states.get(context);

  if (state === undefined) {
    state = {
      unexpectedRequests: [],
      connectionRefused: [],
      responses: new Map([['GET /v1/auth/session', { status: 200, json: { authenticated: false } }]]),
      serviceWorkers: options.serviceWorkers ?? 'block',
      attachedPages: new WeakSet<Page>(),
      primaryPage: page,
    };
    states.set(context, state);
  } else if (options.serviceWorkers !== undefined && options.serviceWorkers !== state.serviceWorkers) {
    throw new Error('Offline E2E service worker policy must be selected on the first installation');
  }

  for (const [key, response] of Object.entries(options.responses ?? {})) {
    state.responses.set(key, response);
  }

  if (state.setup === undefined) state.setup = installContextGuard(page, state);
  await state.setup;
};

export const assertOfflineBackendClean = (page: Page): void => {
  const state = states.get(page.context());
  if (state === undefined) return;

  if (state.unexpectedRequests.length > 0) {
    throw new Error(`Offline E2E made unexpected API requests: ${state.unexpectedRequests.join(', ')}`);
  }
  if (state.connectionRefused.length > 0) {
    throw new Error(`Offline E2E log contains connection-refused errors: ${state.connectionRefused.join(', ')}`);
  }
};
