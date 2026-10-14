import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../api/apiClient';
import type { BringCredentials, BringMutation } from '@ikuck/shared/bring';
import { createBringApi } from './bringApi';

describe('Bring frontend API', () => {
  it('uses relative paths, exact commands, CSRF and AbortSignal', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const api = createBringApi(request as unknown as ApiRequest);
    const signal = new AbortController().signal;
    const credentials: BringCredentials = {
      email: 'test@example.com',
      password: 'synthetic-password',
      confirmExternalAccess: true,
    };
    const mutation: BringMutation = {
      connectionId: 'connection-one',
      listId: 'list-one',
      action: 'update',
      name: 'Pane',
      specification: 'integrale',
      expectedSpecification: 'bianco',
    };

    await api.status(signal);
    await api.connect(credentials, 'csrf-connect', signal);
    await api.lists('connection&one', signal);
    await api.items('connection&one', 'list+one', signal);
    await api.write(mutation, 'csrf-write', signal);
    await api.disconnect('connection-one', 'csrf-disconnect', signal);

    expect(request).toHaveBeenNthCalledWith(1, '/v1/integrations/bring', { signal });
    expect(request).toHaveBeenNthCalledWith(2, '/v1/integrations/bring/connection', {
      method: 'POST', body: credentials, csrfToken: 'csrf-connect', signal,
    });
    expect(request).toHaveBeenNthCalledWith(3, '/v1/integrations/bring/lists?connectionId=connection%26one', { signal });
    expect(request).toHaveBeenNthCalledWith(4, '/v1/integrations/bring/items?connectionId=connection%26one&listId=list%2Bone', { signal });
    expect(request).toHaveBeenNthCalledWith(5, '/v1/integrations/bring/items', {
      method: 'POST', body: mutation, csrfToken: 'csrf-write', signal,
    });
    expect(request).toHaveBeenNthCalledWith(6, '/v1/integrations/bring/connection', {
      method: 'DELETE', body: { connectionId: 'connection-one' }, csrfToken: 'csrf-disconnect', signal,
    });
    expect(request.mock.calls.every(([path]) => path.startsWith('/v1/integrations/bring'))).toBe(true);
  });

  it('propagates request failures unchanged', async () => {
    const failure = new Error('synthetic API failure');
    const request = vi.fn().mockRejectedValue(failure);
    const api = createBringApi(request as unknown as ApiRequest);

    await expect(api.status()).rejects.toBe(failure);
  });

  it('uses apiRequest with same-origin cookies, CSRF headers and abort signals', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    try {
      const api = createBringApi();
      const signal = new AbortController().signal;
      const credentials: BringCredentials = {
        email: 'test@example.com',
        password: 'synthetic-password',
        confirmExternalAccess: true,
      };
      const mutation: BringMutation = {
        connectionId: 'connection-one',
        listId: 'list-one',
        action: 'add',
        name: 'Latte',
        specification: 'fresco',
      };

      await api.status(signal);
      await api.connect(credentials, 'csrf-connect', signal);
      await api.write(mutation, 'csrf-write', signal);
      await api.disconnect('connection-one', 'csrf-disconnect', signal);

      expect(fetch).toHaveBeenNthCalledWith(1, '/v1/integrations/bring', expect.objectContaining({
        method: 'GET', credentials: 'include', signal,
      }));
      expect(fetch).toHaveBeenNthCalledWith(2, '/v1/integrations/bring/connection', expect.objectContaining({
        method: 'POST', credentials: 'include', signal,
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-connect' }),
        body: JSON.stringify(credentials),
      }));
      expect(fetch).toHaveBeenNthCalledWith(3, '/v1/integrations/bring/items', expect.objectContaining({
        method: 'POST', credentials: 'include', signal,
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-write' }),
        body: JSON.stringify(mutation),
      }));
      expect(fetch).toHaveBeenNthCalledWith(4, '/v1/integrations/bring/connection', expect.objectContaining({
        method: 'DELETE', credentials: 'include', signal,
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-disconnect' }),
        body: JSON.stringify({ connectionId: 'connection-one' }),
      }));
      expect(fetch.mock.calls.every(([path]) => typeof path === 'string' && path.startsWith('/v1/'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
