import type { Page } from '@playwright/test';

interface OfflineBackendState {
  unexpectedRequests: string[];
  connectionRefused: string[];
}

export interface OfflineApiResponse {
  status?: number;
  json: unknown;
}

export interface OfflineBackendOptions {
  responses?: Record<string, OfflineApiResponse>;
}

const states = new WeakMap<Page, OfflineBackendState>();

const requestDescription = (method: string, url: string): string => {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname}${parsed.search}`;
  } catch {
    return `${method} ${url}`;
  }
};

const includesConnectionRefused = (value: string | undefined): boolean => (
  value?.includes('ECONNREFUSED') === true
  || value?.includes('ERR_CONNECTION_REFUSED') === true
);

export const installOfflineBackend = async (page: Page, options: OfflineBackendOptions = {}): Promise<void> => {
  const state: OfflineBackendState = { unexpectedRequests: [], connectionRefused: [] };
  states.set(page, state);

  page.on('console', (message) => {
    if (includesConnectionRefused(message.text())) state.connectionRefused.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText;
    if (includesConnectionRefused(failure)) {
      state.connectionRefused.push(requestDescription(request.method(), request.url()));
    }
  });

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = requestDescription(request.method(), request.url());
    const configuredResponse = options.responses?.[`${request.method()} ${url.pathname}`];

    if (configuredResponse !== undefined) {
      await route.fulfill({ status: configuredResponse.status ?? 200, json: configuredResponse.json });
      return;
    }

    if (url.pathname === '/v1/auth/session' && request.method() === 'GET') {
      await route.fulfill({ status: 200, json: { authenticated: false } });
      return;
    }

    state.unexpectedRequests.push(description);
    await route.abort('failed');
    throw new Error(`Unexpected API request in offline E2E mode: ${description}`);
  });
};

export const assertOfflineBackendClean = (page: Page): void => {
  const state = states.get(page);
  if (state === undefined) return;

  if (state.unexpectedRequests.length > 0) {
    throw new Error(`Offline E2E made unexpected API requests: ${state.unexpectedRequests.join(', ')}`);
  }
  if (state.connectionRefused.length > 0) {
    throw new Error(`Offline E2E log contains connection-refused errors: ${state.connectionRefused.join(', ')}`);
  }
};
