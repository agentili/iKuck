import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../auth/authStore';
import { ApiClientError } from '../api/apiClient';
import HousePage from './HousePage';
import { useHouseStore } from '../house/houseStore';

const user = { id: 'admin-1', email: 'admin@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' };
const baseActions = {
  refresh: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue(undefined),
  addMember: vi.fn().mockResolvedValue(undefined),
  importPersonalData: vi.fn().mockResolvedValue(undefined),
  changeRole: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
  leave: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn(),
};

describe('HousePage', () => {
  beforeEach(() => {
    useAuthStore.setState({ user, csrfToken: 'csrf', expiresAt: null, connection: 'online', isLoading: false });
    useHouseStore.setState({ state: null, isLoading: false, error: null, ...baseActions });
  });

  it('offers house creation when the account has no house', () => {
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'La mia casa', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crea casa' })).toBeInTheDocument();
  });

  it('explains that guest data stays on this device until explicitly imported', () => {
    useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'La mia casa', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/i dati ospite restano su questo dispositivo/i)).toBeInTheDocument();
    expect(screen.getByText(/non vengono importati automaticamente/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accedi o crea un account' })).toHaveAttribute('href', '/profile');
  });

  it('describes account data and device-only guest data separately before house creation', () => {
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/la Casa condividerà dispensa, spesa, attività, ricette salvate, preferenze alimentari e di ricetta, Piano e Diario/i)).toBeInTheDocument();
    expect(screen.getByText(/i dati funzionali già salvati nel tuo account verranno trasferiti alla Casa/i)).toBeInTheDocument();
    expect(screen.getByText(/i dati ospite presenti solo su questo dispositivo non vengono importati automaticamente/i)).toBeInTheDocument();
    expect(screen.getByText(/identità, il consenso AI e le anteprime non salvate restano personali/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crea casa' })).toHaveClass('ik-button-primary', 'text-[var(--ik-porcelain)]');
  });

  it('explains house-shared data and keeps AI consent personal for members', () => {
    useHouseStore.setState({
      state: {
        house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' },
        members: [{ userId: user.id, email: user.email, displayName: null, role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }],
      },
    });
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/Dispensa, spesa, attività, ricette salvate, preferenze alimentari e di ricetta, Piano e Diario appartengono alla Casa/i)).toBeInTheDocument();
    expect(screen.getByText(/tutti i membri, che possono creare, modificare ed eliminare questi contenuti/i)).toBeInTheDocument();
    expect(screen.getByText(/l’identità e il consenso AI restano personali; le anteprime non salvate non vengono condivise/i)).toBeInTheDocument();
    expect(screen.getByText('Il tuo ruolo: Membro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova importazione dati funzionali' })).toBeInTheDocument();
  });

  it('explains member-lookup throttling without displaying the submitted email', () => {
    useHouseStore.setState({ error: new ApiClientError(429, 'rate_limited', 'Too many requests') });
    render(<MemoryRouter><HousePage /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('Troppe richieste. Riprova più tardi.');
    expect(screen.getByRole('alert')).not.toHaveTextContent(user.email);
  });

  it('shows admin membership controls and sends the normalized form value', async () => {
    useHouseStore.setState({
      state: {
        house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
        membership: { role: 'admin', joinedAt: '2026-09-24T00:00:00.000Z' },
        members: [{ userId: 'admin-1', email: user.email, displayName: null, role: 'admin', joinedAt: '2026-09-24T00:00:00.000Z' }],
      },
    });
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Casa' })).toBeInTheDocument();
    expect(screen.getByText('Il tuo ruolo: Amministratore')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aggiungi persona' })).toHaveClass('ik-button-primary', 'text-[var(--ik-porcelain)]');
    const email = screen.getByLabelText('Email della persona');
    fireEvent.change(email, { target: { value: ' MEMBER@EXAMPLE.COM ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi persona' }));

    expect(baseActions.addMember).toHaveBeenCalledWith('MEMBER@EXAMPLE.COM', 'csrf');
  });
});
