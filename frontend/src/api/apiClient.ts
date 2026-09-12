export interface ApiRequestOptions<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: TBody;
  csrfToken?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export type ApiRequest = <T>(path: string, options?: ApiRequestOptions) => Promise<T>;

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const isRelativeApiPath = (path: string): boolean => path.startsWith('/') && !path.startsWith('//') && !/^\/\/|^[a-z][a-z\d+.-]*:/i.test(path);

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.trim() === '') return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const apiRequest: ApiRequest = async <T>(path: string, options: ApiRequestOptions = {}): Promise<T> => {
  if (!isRelativeApiPath(path)) {
    throw new ApiClientError(0, 'invalid_api_path', 'API path must be same-origin');
  }

  const requestFetch = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrfToken !== undefined) headers['x-csrf-token'] = options.csrfToken;

  let response: Response;
  try {
    response = await requestFetch(path, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    throw new ApiClientError(0, 'network_error', 'Network request failed');
  }

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const errorPayload = typeof payload === 'object' && payload !== null
      ? payload as { code?: unknown; message?: unknown }
      : {};
    const code = typeof errorPayload.code === 'string' ? errorPayload.code : 'request_failed';
    const message = typeof errorPayload.message === 'string' ? errorPayload.message : 'Request failed';
    throw new ApiClientError(response.status, code, message);
  }

  return payload as T;
};
