import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CandidatesInbox from './CandidatesInbox';
import { useAuthStore } from '../../auth/authStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const candidates = [
  {
    id: 'c-1',
    label: 'Latte',
    rawLabel: 'Latte',
    normalizedLabel: 'latte',
    specification: '1 l',
    listName: 'Spesa',
    checkedOffAt: '2026-01-15T10:00:00.000Z',
    detectedAt: '2026-01-15T10:00:00.000Z',
    expiresAt: '2026-02-14T10:00:00.000Z',
    status: 'pending' as const,
  },
  {
    id: 'c-2',
    label: 'Pasta',
    rawLabel: 'Pasta',
    normalizedLabel: 'pasta',
    specification: '500 g',
    listName: 'Spesa',
    checkedOffAt: null,
    detectedAt: '2026-01-16T09:00:00.000Z',
    expiresAt: '2026-02-15T09:00:00.000Z',
    status: 'pending' as const,
  },
];

const json = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

let fetchMock: ReturnType<typeof vi.fn>;

const setupAuthenticated = () => {
  useAuthStore.setState({
    user: verifiedUser,
    csrfToken: 'csrf-1',
    connection: 'online',
  });
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  usePantryCandidatesBadgeStore.getState().reset();
  useAuthStore.setState({
    user: null,
    csrfToken: null,
    connection: 'unknown',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CandidatesInbox', () => {
  it('non rende nulla per ospite o sessione non verificata', () => {
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);
    expect(screen.queryByText('Da confermare')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non rende nulla senza casa anche se la sessione è verificata', () => {
    setupAuthenticated();
    render(<MemoryRouter><CandidatesInbox houseId={null} /></MemoryRouter>);
    expect(screen.queryByText('Da confermare')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recupera i candidati all’apertura e li mostra con metadata', async () => {
    setupAuthenticated();
    fetchMock.mockResolvedValue(json({ candidates }));
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Da confermare')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/v1/pantry/candidates', expect.objectContaining({
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
      credentials: 'include',
    }));
    await waitFor(() => expect(screen.getByText('Latte')).toBeInTheDocument());
    expect(screen.getByText('Pasta')).toBeInTheDocument();
    expect(screen.getByText('1 l')).toBeInTheDocument();
    expect(screen.getByText('500 g')).toBeInTheDocument();
    expect(screen.getAllByText(/Spesa/)).toHaveLength(2);
  });

  it('associa il badge alla casa e aggiorna il conto pendente con un solo fetch', async () => {
    setupAuthenticated();
    fetchMock.mockResolvedValue(json({ candidates }));
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(usePantryCandidatesBadgeStore.getState().pendingCount).toBe(2));
    expect(usePantryCandidatesBadgeStore.getState().houseId).toBe('house-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mostra lo stato vuoto quando non ci sono candidati', async () => {
    setupAuthenticated();
    fetchMock.mockResolvedValue(json({ candidates: [] }));
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText(/Nessun articolo da confermare/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Accetta/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accetta ottimisticamente e conferma dopo il successo dell’API', async () => {
    setupAuthenticated();
    fetchMock
      .mockResolvedValueOnce(json({ candidates }))
      .mockResolvedValueOnce(json({ results: [{ id: 'c-1', ok: true, code: 'accepted' }] }));
    const user = userEvent.setup();
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Latte')).toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: 'Seleziona Latte' }));
    await user.click(screen.getByRole('button', { name: 'Accetta selezionati' }));

    await waitFor(() => expect(screen.queryByText('Latte')).not.toBeInTheDocument());
    const acceptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept'));
    expect(acceptCall).toBeDefined();
    expect(JSON.parse(String(acceptCall![1]!.body))).toEqual({ ids: ['c-1'] });
    expect(usePantryCandidatesBadgeStore.getState().pendingCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('effettua il rollback e mostra il codice motivo se l’accettazione fallisce', async () => {
    setupAuthenticated();
    fetchMock
      .mockResolvedValueOnce(json({ candidates }))
      .mockResolvedValueOnce(json({ code: 'not_found' }, 404));
    const user = userEvent.setup();
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Latte')).toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: 'Seleziona Latte' }));
    await user.click(screen.getByRole('button', { name: 'Accetta selezionati' }));

    await waitFor(() => expect(screen.getByText('Latte')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/non è più disponibile/));
    expect(usePantryCandidatesBadgeStore.getState().pendingCount).toBe(2);
    // Il corpo grezzo (codici, token) non deve comparire nell’interfaccia.
    expect(screen.queryByText('not_found')).not.toBeInTheDocument();
    expect(screen.queryByText('csrf-1')).not.toBeInTheDocument();
  });

  it('ignora un candidato e lo rimuove definitivamente', async () => {
    setupAuthenticated();
    fetchMock
      .mockResolvedValueOnce(json({ candidates }))
      .mockResolvedValueOnce(json({ results: [{ id: 'c-1', ok: true, code: 'ignored' }] }));
    const user = userEvent.setup();
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Latte')).toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: 'Seleziona Latte' }));
    await user.click(screen.getByRole('button', { name: 'Ignora selezionati' }));

    await waitFor(() => expect(screen.queryByText('Latte')).not.toBeInTheDocument());
    const ignoreCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/ignore'));
    expect(ignoreCall).toBeDefined();
    expect(JSON.parse(String(ignoreCall![1]!.body))).toEqual({ ids: ['c-1'] });
    expect(usePantryCandidatesBadgeStore.getState().pendingCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('seleziona al massimo 100 candidati con «Seleziona tutto»', async () => {
    setupAuthenticated();
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: `c-${i}`,
      label: `Articolo ${i}`,
      rawLabel: `Articolo ${i}`,
      normalizedLabel: `articolo-${i}`,
      specification: '',
      listName: 'Spesa',
      checkedOffAt: null,
      detectedAt: '2026-01-15T10:00:00.000Z',
      expiresAt: '2026-02-14T10:00:00.000Z',
      status: 'pending' as const,
    }));
    fetchMock.mockResolvedValue(json({ candidates: many }));
    const user = userEvent.setup();
    render(<MemoryRouter><CandidatesInbox houseId="house-a" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Articolo 0')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Seleziona tutto' }));

    const checked = screen.getAllByRole('checkbox', { checked: true });
    expect(checked).toHaveLength(100);
  });
});
