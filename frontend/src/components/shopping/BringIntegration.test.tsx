import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import BringIntegration from './BringIntegration';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  lists: vi.fn(),
  items: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../../bring/bringApi', () => ({ createBringApi: () => mocks }));

const connectionId = '22222222-2222-4222-8222-222222222222';
const listId = '11111111-1111-4111-8111-111111111111';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe('Bring integration panel', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    useAuthStore.setState({
      user: { id: 'user-a', email: 'a@example.com', emailVerifiedAt: '2026-10-01T00:00:00.000Z' },
      csrfToken: 'synthetic-csrf',
    });
    mocks.status.mockResolvedValue({ enabled: true, connected: false, connectionId: null });
    mocks.connect.mockResolvedValue({
      enabled: true,
      connected: true,
      connectionId,
      lists: [{ id: listId, name: 'Casa' }],
    });
    mocks.items.mockResolvedValue({
      connectionId,
      listId,
      labelsAvailable: true,
      items: [{ name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearSession();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('requires consent, clears the password, and reads only an explicitly selected list', async () => {
    const user = userEvent.setup();
    const pendingConnect = deferred<{
      enabled: boolean;
      connected: boolean;
      connectionId: string;
      lists: Array<{ id: string; name: string }>;
    }>();
    mocks.connect.mockReturnValue(pendingConnect.promise);

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    await screen.findByLabelText('Email Bring!');
    const email = screen.getByLabelText('Email Bring!');
    const password = screen.getByLabelText('Password Bring!');
    await user.type(email, 'test@example.com');
    await user.type(password, 'synthetic-password');

    const connectButton = screen.getByRole('button', { name: 'Collega Bring!' });
    expect(connectButton).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Autorizzo/i }));
    await user.click(connectButton);

    await waitFor(() => expect(password).toHaveValue(''));
    expect(mocks.connect).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'synthetic-password',
      confirmExternalAccess: true,
    }, 'synthetic-csrf', expect.any(AbortSignal));
    expect(localStorage.getItem('bring-password')).toBeNull();
    expect(sessionStorage.getItem('bring-password')).toBeNull();
    expect(localStorage.getItem('bring-connection')).toBeNull();
    expect(sessionStorage.getItem('bring-connection')).toBeNull();

    await act(async () => {
      pendingConnect.resolve({
        enabled: true,
        connected: true,
        connectionId,
        lists: [{ id: listId, name: 'Casa' }],
      });
    });

    const pendingItems = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.items.mockReturnValue(pendingItems.promise);
    const listSelect = await screen.findByRole('combobox', { name: 'Lista Bring!' });
    expect(listSelect).toHaveValue('');
    expect(mocks.items).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();

    await user.selectOptions(listSelect, listId);
    await act(async () => {
      pendingItems.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true }],
      });
    });
    const translatedItem = await screen.findByText('Latte');
    expect(translatedItem.closest('li')).toHaveAttribute('data-bring-name', 'Milch');
    expect(mocks.items).toHaveBeenCalledWith(connectionId, listId, expect.any(AbortSignal));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('shows list retrieval failures instead of presenting them as an empty list', async () => {
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockRejectedValue(new ApiClientError(503, 'bring_busy', 'synthetic upstream failure'));

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Un’operazione Bring! è già in corso.');
    expect(screen.queryByText('Non ci sono liste Bring! disponibili.')).not.toBeInTheDocument();
  });

  it('announces the initial connection check while the status request is pending', async () => {
    const pendingStatus = deferred<{ enabled: boolean; connected: false; connectionId: null }>();
    mocks.status.mockReturnValue(pendingStatus.promise);

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    expect(screen.getByRole('status')).toHaveTextContent('Operazione Bring! in corso');
    await act(async () => {
      pendingStatus.resolve({ enabled: true, connected: false, connectionId: null });
    });
    expect(await screen.findByLabelText('Email Bring!')).toBeInTheDocument();
  });

  it('keeps credentials hidden when the integration is disabled on this installation', async () => {
    mocks.status.mockResolvedValue({ enabled: false, connected: false, connectionId: null });

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    expect(await screen.findByText('Bring! non è configurato su questa installazione.')).toBeVisible();
    expect(screen.queryByLabelText('Password Bring!')).not.toBeInTheDocument();
  });

  it('shows an empty state only after a successful response with no remote lists', async () => {
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockResolvedValue({ connectionId, lists: [] });

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    expect(await screen.findByText('Non ci sono liste Bring! disponibili.')).toBeVisible();
    expect(mocks.items).not.toHaveBeenCalled();
  });

  it('shows an empty state when the selected remote list contains no items', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockResolvedValue({ connectionId, lists: [{ id: listId, name: 'Casa' }] });
    mocks.items.mockResolvedValue({ connectionId, listId, labelsAvailable: true, items: [] });

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Lista Bring!' }), listId);
    expect(await screen.findByText('La lista Bring! è vuota.')).toBeVisible();
  });
});
