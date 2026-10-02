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

    expect(screen.getByRole('heading', { name: 'La mia casa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crea casa' })).toBeInTheDocument();
  });

  it('describes every functional record as shared and keeps identity and AI consent personal', () => {
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/dispensa, la lista della spesa, le attività, le ricette generate, il diario delle cene e le preferenze ricetta/)).toBeInTheDocument();
    expect(screen.getByText(/unico profilo alimentare e allergeni/)).toBeInTheDocument();
    expect(screen.getByText(/identità dell’account e il consenso AI restano personali/)).toBeInTheDocument();
    expect(screen.getByText(/dati funzionali preesistenti vengono importati automaticamente/)).toBeInTheDocument();
  });

  it('explains full house sharing and automatic import to existing members', () => {
    useHouseStore.setState({
      state: {
        house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' },
        members: [{ userId: user.id, email: user.email, displayName: null, role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }],
      },
    });
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/tutti i membri possono creare, modificare ed eliminare/)).toBeInTheDocument();
    expect(screen.getByText(/importati automaticamente/)).toBeInTheDocument();
    expect(screen.getByText(/consenso AI resta personale/)).toBeInTheDocument();
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
    const email = screen.getByLabelText('Email della persona');
    fireEvent.change(email, { target: { value: ' MEMBER@EXAMPLE.COM ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi persona' }));

    expect(baseActions.addMember).toHaveBeenCalledWith('MEMBER@EXAMPLE.COM', 'csrf');
  });
});
