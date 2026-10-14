import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../api/apiClient';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH } from '@ikuck/shared/bring';
import { useAuthStore } from '../../auth/authStore';
import BringIntegration from './BringIntegration';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  lists: vi.fn(),
  items: vi.fn(),
  write: vi.fn(),
  importList: vi.fn(),
}));

const syncVerifiedSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('../../bring/bringApi', () => ({ createBringApi: () => mocks }));

vi.mock('../../sync/syncQueue', async () => {
  const actual = await vi.importActual<typeof import('../../sync/syncQueue')>('../../sync/syncQueue');
  return { ...actual, syncVerifiedSession };
});

const connectionId = '22222222-2222-4222-8222-222222222222';
const listId = '11111111-1111-4111-8111-111111111111';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const renderSelectedList = async (items: Array<{
  name: string;
  label: string;
  specification: string;
  state: 'purchase' | 'recently';
  mutable: boolean;
}> = []) => {
  const user = userEvent.setup();
  mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
  mocks.lists.mockResolvedValue({ connectionId, lists: [{ id: listId, name: 'Casa' }] });
  mocks.items.mockResolvedValue({ connectionId, listId, labelsAvailable: true, items });
  render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Lista Bring!' }), listId);
  if (items.length === 0) await screen.findByText('La lista Bring! è vuota.');
  else await screen.findByText(items[0]!.label);
  return user;
};

describe('Bring integration panel', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    syncVerifiedSession.mockReset();
    syncVerifiedSession.mockResolvedValue(null);
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

  it('explains when Bring refuses a list outside the enabled test list', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockResolvedValue({ connectionId, lists: [{ id: listId, name: 'Casa' }] });
    mocks.items.mockRejectedValue(new ApiClientError(403, 'bring_list_not_allowed', 'synthetic gate refusal'));

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Lista Bring!' }), listId);

    expect(await screen.findByRole('alert')).toHaveTextContent('Questa lista non è abilitata su questa installazione.');
    expect(screen.queryByRole('button', { name: 'Ricollega Bring!' })).not.toBeInTheDocument();
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

  it('shows add success only after the server returns a verified snapshot', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList();

    await user.type(screen.getByLabelText('Cosa aggiungere a Bring!'), 'Pane');
    await user.type(screen.getByLabelText('Specifica Bring!'), '2 filoni');
    await user.click(screen.getByRole('button', { name: 'Aggiungi a Bring!' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({
      connectionId,
      listId,
      action: 'add',
      name: 'Pane',
      specification: '2 filoni',
    }, 'synthetic-csrf', expect.any(AbortSignal)));
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '2 filoni', state: 'purchase', mutable: true }],
      });
    });

    expect(await screen.findByText('Modifica confermata su Bring!.')).toBeVisible();
    expect(screen.getByLabelText('Cosa aggiungere a Bring!')).toHaveValue('');
    expect(screen.getByLabelText('Specifica Bring!')).toHaveValue('');
  });

  it('shows update success only after the server returns the changed specification', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList([{
      name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true,
    }]);

    await user.click(screen.getByText('Modifica specifica di Pane'));
    const specification = screen.getByLabelText('Nuova specifica di Pane');
    await user.clear(specification);
    await user.type(specification, '2 kg');
    await user.click(screen.getByRole('button', { name: 'Salva specifica di Pane' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({
      connectionId,
      listId,
      action: 'update',
      name: 'Pane',
      specification: '2 kg',
      expectedSpecification: '1 kg',
    }, 'synthetic-csrf', expect.any(AbortSignal)));
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '2 kg', state: 'purchase', mutable: true }],
      });
    });

    expect(await screen.findByText('Modifica confermata su Bring!.')).toBeVisible();
    expect(await screen.findByText('2 kg')).toBeVisible();
  });

  it('shows complete success only after the server returns the item in recently purchased', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'recently'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList([{
      name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true,
    }]);

    await user.click(screen.getByRole('button', { name: 'Segna Pane acquistato su Bring!' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({
      connectionId,
      listId,
      action: 'complete',
      name: 'Pane',
      specification: '1 kg',
      expectedSpecification: '1 kg',
    }, 'synthetic-csrf', expect.any(AbortSignal)));
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '1 kg', state: 'recently', mutable: true }],
      });
    });

    expect(await screen.findByText('Modifica confermata su Bring!.')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Acquistati su Bring!' })).toBeVisible();
  });

  it('shows restore success only after the server returns the item to purchase', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList([{
      name: 'Pane', label: 'Pane', specification: '1 kg', state: 'recently', mutable: true,
    }]);

    await user.click(screen.getByRole('button', { name: 'Ripristina Pane su Bring!' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({
      connectionId,
      listId,
      action: 'restore',
      name: 'Pane',
      specification: '1 kg',
      expectedSpecification: '1 kg',
    }, 'synthetic-csrf', expect.any(AbortSignal)));
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true }],
      });
    });

    expect(await screen.findByText('Modifica confermata su Bring!.')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Da acquistare su Bring!' })).toBeVisible();
  });

  it('shows remove success only after the server confirms the item is absent', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: [];
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList([{
      name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true,
    }]);

    await user.click(screen.getByRole('button', { name: 'Rimuovi Pane da Bring!' }));

    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({
      connectionId,
      listId,
      action: 'remove',
      name: 'Pane',
      specification: '1 kg',
      expectedSpecification: '1 kg',
    }, 'synthetic-csrf', expect.any(AbortSignal)));
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({ connectionId, listId, labelsAvailable: true, items: [] });
    });

    expect(await screen.findByText('Modifica confermata su Bring!.')).toBeVisible();
    expect(await screen.findByText('La lista Bring! è vuota.')).toBeVisible();
  });

  it('preserves the add draft when Bring cannot confirm the remote write', async () => {
    mocks.write.mockRejectedValue(new ApiClientError(503, 'bring_write_unconfirmed', 'synthetic upstream detail'));
    const user = await renderSelectedList();
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    const specification = screen.getByLabelText('Specifica Bring!');

    await user.type(name, 'Pane');
    await user.type(specification, '2 filoni');
    await user.click(screen.getByRole('button', { name: 'Aggiungi a Bring!' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Non posso confermare la modifica. Aggiorna la lista prima di riprovare.');
    expect(name).toHaveValue('Pane');
    expect(specification).toHaveValue('2 filoni');
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();
  });

  it('blocks adding an item already on the remote purchase list by its raw or localized name', async () => {
    const user = await renderSelectedList([{
      name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true,
    }]);
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    await user.type(name, '  latte  ');

    const add = screen.getByRole('button', { name: 'Aggiungi a Bring!' });
    expect(add).toBeDisabled();
    await user.click(add);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('rejects a successful response for a different remote list and preserves the draft', async () => {
    mocks.write.mockResolvedValue({
      connectionId,
      listId: '33333333-3333-4333-8333-333333333333',
      labelsAvailable: true,
      items: [{ name: 'Pane', label: 'Pane', specification: '2 filoni', state: 'purchase', mutable: true }],
    });
    const user = await renderSelectedList();
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    const specification = screen.getByLabelText('Specifica Bring!');
    await user.type(name, 'Pane');
    await user.type(specification, '2 filoni');
    await user.click(screen.getByRole('button', { name: 'Aggiungi a Bring!' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Non posso confermare la modifica. Aggiorna la lista prima di riprovare.');
    expect(name).toHaveValue('Pane');
    expect(specification).toHaveValue('2 filoni');
    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();
  });

  it.each([
    { field: 'name', name: 'N'.repeat(BRING_NAME_MAX_LENGTH + 1), specification: '1 l' },
    { field: 'specification', name: 'Pane', specification: 'S'.repeat(BRING_SPEC_MAX_LENGTH + 1) },
  ])('does not offer remote mutations for an oversized item $field', async ({ name, specification }) => {
    await renderSelectedList([{
      name, label: name, specification, state: 'purchase', mutable: true,
    }]);

    const row = screen.getByRole('listitem');
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row).getByText(/Articolo non modificabile in sicurezza/)).toBeVisible();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('enforces the shared add-item limits for name and specification', async () => {
    await renderSelectedList();
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    const specification = screen.getByLabelText('Specifica Bring!');
    const add = screen.getByRole('button', { name: 'Aggiungi a Bring!' });

    expect(name).toHaveAttribute('maxLength', String(BRING_NAME_MAX_LENGTH));
    expect(specification).toHaveAttribute('maxLength', String(BRING_SPEC_MAX_LENGTH));
    fireEvent.change(name, { target: { value: 'N'.repeat(BRING_NAME_MAX_LENGTH + 1) } });
    expect(add).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Pane' } });
    fireEvent.change(specification, { target: { value: 'S'.repeat(BRING_SPEC_MAX_LENGTH + 1) } });
    expect(add).toBeDisabled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('disables remote actions while offline without sending or queueing a write', async () => {
    await renderSelectedList();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByText('Sei offline: i dati Bring! mostrati potrebbero non essere aggiornati. Le modifiche sono disabilitate.')).toBeVisible();
    expect(screen.getByLabelText('Cosa aggiungere a Bring!')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Aggiungi a Bring!' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Importa nella lista iKuck' })).toBeDisabled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.importList).not.toHaveBeenCalled();
  });

  it('asks to reconnect after an expired Bring session without logging out of iKuck', async () => {
    mocks.write.mockRejectedValue(new ApiClientError(409, 'bring_reconnect_required', 'synthetic expired session'));
    const user = await renderSelectedList([{
      name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true,
    }]);

    await user.click(screen.getByRole('button', { name: 'Rimuovi Pane da Bring!' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Il collegamento è scaduto. Ricollega Bring!.');
    expect(await screen.findByText('Ricollega Bring!')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Da acquistare su Bring!' })).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.id).toBe('user-a');
    expect(useAuthStore.getState().csrfToken).toBe('synthetic-csrf');
  });

  it.each(['account', 'csrf token'] as const)('ignores a pending response after the %s changes', async (changed) => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList();
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    await user.type(name, 'Pane');
    await user.click(screen.getByRole('button', { name: 'Aggiungi a Bring!' }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));

    act(() => {
      useAuthStore.setState({
        user: {
          id: changed === 'account' ? 'user-b' : 'user-a',
          email: changed === 'account' ? 'b@example.com' : 'a@example.com',
          emailVerifiedAt: '2026-10-01T00:00:00.000Z',
        },
        csrfToken: changed === 'csrf token' ? 'new-synthetic-csrf' : 'synthetic-csrf',
      });
    });
    expect(await screen.findByText('Collega Bring! con una sessione verificata iKuck.')).toBeVisible();

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '', state: 'purchase', mutable: true }],
      });
    });

    expect(screen.queryByText('Modifica confermata su Bring!.')).not.toBeInTheDocument();
    expect(screen.queryByText('Pane')).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.id).toBe(changed === 'account' ? 'user-b' : 'user-a');
  });

  it('aborts an in-flight remote write when the component unmounts', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockResolvedValue({ connectionId, lists: [{ id: listId, name: 'Casa' }] });
    mocks.items.mockResolvedValue({ connectionId, listId, labelsAvailable: true, items: [] });
    const user = userEvent.setup();
    const view = render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Lista Bring!' }), listId);
    await screen.findByText('La lista Bring! è vuota.');
    await user.type(screen.getByLabelText('Cosa aggiungere a Bring!'), 'Pane');
    await user.click(screen.getByRole('button', { name: 'Aggiungi a Bring!' }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    const signal = mocks.write.mock.calls[0]?.[2] as AbortSignal;

    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '', state: 'purchase', mutable: true }],
      });
    });
    expect(useAuthStore.getState().user?.id).toBe('user-a');
  });

  it('dispatches only one write when submit fires twice before React can rerender', async () => {
    const pending = deferred<{
      connectionId: string;
      listId: string;
      labelsAvailable: boolean;
      items: Array<{ name: string; label: string; specification: string; state: 'purchase'; mutable: boolean }>;
    }>();
    mocks.write.mockReturnValue(pending.promise);
    const user = await renderSelectedList();
    const name = screen.getByLabelText('Cosa aggiungere a Bring!');
    await user.type(name, 'Pane');
    const form = name.closest('form');
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });
    const dispatchCount = mocks.write.mock.calls.length;

    await act(async () => {
      pending.resolve({
        connectionId,
        listId,
        labelsAvailable: true,
        items: [{ name: 'Pane', label: 'Pane', specification: '', state: 'purchase', mutable: true }],
      });
    });

    expect(dispatchCount).toBe(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it('offers the one-shot import only after a readable Bring snapshot', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue({ enabled: true, connected: true, connectionId });
    mocks.lists.mockResolvedValue({ connectionId, lists: [{ id: listId, name: 'Casa' }] });
    mocks.items.mockResolvedValue({ connectionId, listId, labelsAvailable: true, items: [] });

    render(<BringIntegration userId="user-a" csrfToken="synthetic-csrf" />);
    await screen.findByRole('combobox', { name: 'Lista Bring!' });
    expect(screen.queryByRole('button', { name: 'Importa nella lista iKuck' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Lista Bring!' }), listId);
    await screen.findByText('La lista Bring! è vuota.');
    expect(screen.getByRole('button', { name: 'Importa nella lista iKuck' })).toBeEnabled();
    expect(mocks.importList).not.toHaveBeenCalled();
    expect(syncVerifiedSession).not.toHaveBeenCalled();
  });

  it('previews purchase and recently purchased counts before the one-shot import', async () => {
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
      { name: 'Brot', label: 'Pane', specification: '400 g', state: 'purchase', mutable: true },
      { name: 'Eier', label: 'Uova', specification: '', state: 'recently', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    const confirmation = screen.getByRole('group', { name: 'Importa nella lista iKuck' });
    expect(within(confirmation).getByText('2 articoli da acquistare da importare')).toBeVisible();
    expect(within(confirmation).getByText('1 già acquistati su Bring! non verranno importati')).toBeVisible();
    expect(within(confirmation).getByText(/Copia una tantum/)).toBeVisible();
    expect(within(confirmation).getByText(/NON viene modificata/)).toBeVisible();
    expect(within(confirmation).getByText(/restano separate/)).toBeVisible();
    expect(within(confirmation).getByText(/Nessuna sincronizzazione continua/)).toBeVisible();
    expect(mocks.importList).not.toHaveBeenCalled();
    expect(syncVerifiedSession).not.toHaveBeenCalled();
  });

  it('omits the purchased preview when the Bring list has none', async () => {
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    const confirmation = screen.getByRole('group', { name: 'Importa nella lista iKuck' });
    expect(within(confirmation).getByText('1 articoli da acquistare da importare')).toBeVisible();
    expect(within(confirmation).queryByText(/già acquistati su Bring!/)).not.toBeInTheDocument();
  });

  it('closes the confirmation without touching the import endpoint', async () => {
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(screen.queryByRole('group', { name: 'Importa nella lista iKuck' })).not.toBeInTheDocument();
    expect(mocks.importList).not.toHaveBeenCalled();
    expect(syncVerifiedSession).not.toHaveBeenCalled();
  });

  it('imports with the pinned body and reports every real server count', async () => {
    const pendingImport = deferred<{ imported: number; skipped: number; recently: number }>();
    mocks.importList.mockReturnValue(pendingImport.promise);
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
      { name: 'Eier', label: 'Uova', specification: '', state: 'recently', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    await user.click(screen.getByRole('button', { name: 'Conferma importazione' }));

    await waitFor(() => expect(mocks.importList).toHaveBeenCalledWith(
      { connectionId, listId },
      'synthetic-csrf',
      expect.any(AbortSignal),
    ));
    expect(screen.queryByText(/^Importati/)).not.toBeInTheDocument();

    await act(async () => {
      pendingImport.resolve({ imported: 3, skipped: 1, recently: 2 });
    });

    expect(await screen.findByText(
      'Importati 3 articoli nella lista iKuck. 1 erano già presenti o non importabili. 2 articoli acquistati non sono stati importati.',
    )).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Importa nella lista iKuck' })).not.toBeInTheDocument();
    expect(mocks.importList).toHaveBeenCalledTimes(1);
  });

  it('omits zero counts and refreshes the iKuck list through the existing sync path', async () => {
    const pendingSync = deferred<null>();
    syncVerifiedSession.mockReturnValue(pendingSync.promise);
    mocks.importList.mockResolvedValue({ imported: 2, skipped: 0, recently: 0 });
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
      { name: 'Eier', label: 'Uova', specification: '', state: 'recently', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    await user.click(screen.getByRole('button', { name: 'Conferma importazione' }));

    expect(await screen.findByText('Importati 2 articoli nella lista iKuck.')).toBeVisible();
    expect(screen.queryByText(/0 erano già presenti/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 articoli acquistati/)).not.toBeInTheDocument();

    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledTimes(1));
    expect(syncVerifiedSession).toHaveBeenCalledWith(
      {
        userId: 'user-a',
        emailVerifiedAt: '2026-10-01T00:00:00.000Z',
        csrfToken: 'synthetic-csrf',
      },
      expect.objectContaining({ isSessionCurrent: expect.any(Function) }),
    );
    const options = syncVerifiedSession.mock.calls[0]?.[1] as { isSessionCurrent: () => boolean };
    expect(options.isSessionCurrent()).toBe(true);

    await act(async () => {
      pendingSync.resolve(null);
    });

    expect(screen.getByText('Importati 2 articoli nella lista iKuck.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.importList).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, code: 'bring_list_not_allowed', expected: 'Questa lista non è abilitata su questa installazione.' },
    { status: 409, code: 'bring_busy', expected: 'Un’operazione Bring! è già in corso. Attendi e aggiorna la lista.' },
  ])('maps a $code import failure to its Italian copy without refreshing', async ({ status, code, expected }) => {
    mocks.importList.mockRejectedValue(new ApiClientError(status, code, 'synthetic import failure'));
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    await user.click(screen.getByRole('button', { name: 'Conferma importazione' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.queryByRole('group', { name: 'Importa nella lista iKuck' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Importati/)).not.toBeInTheDocument();
    expect(syncVerifiedSession).not.toHaveBeenCalled();
    expect(mocks.importList).toHaveBeenCalledTimes(1);
  });

  it('dispatches only one import when the confirmation fires twice before React rerenders', async () => {
    const pendingImport = deferred<{ imported: number; skipped: number; recently: number }>();
    mocks.importList.mockReturnValue(pendingImport.promise);
    const user = await renderSelectedList([
      { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
    ]);

    await user.click(screen.getByRole('button', { name: 'Importa nella lista iKuck' }));
    const confirmation = screen.getByRole('button', { name: 'Conferma importazione' });

    act(() => {
      fireEvent.click(confirmation);
      fireEvent.click(confirmation);
    });
    const dispatchCount = mocks.importList.mock.calls.length;

    await act(async () => {
      pendingImport.resolve({ imported: 1, skipped: 0, recently: 0 });
    });

    expect(dispatchCount).toBe(1);
    expect(mocks.importList).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Importati 1 articoli nella lista iKuck.')).toBeVisible();
    expect(syncVerifiedSession).toHaveBeenCalledTimes(1);
  });
});
