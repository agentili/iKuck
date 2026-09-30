import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../auth/authStore';
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

  it('explains that diary entries and confirmed diary recipes are shared within the house', () => {
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/La casa condividerà la dispensa.*ingredienti, lotti e ingredienti di base/)).toBeInTheDocument();
    expect(screen.getByText(/diario.*ricette confermate dal diario/i)).toBeInTheDocument();
    expect(screen.getByText(/La lista della spesa, le attività, le bozze AI non confermate, le ricette generate e i dati del profilo restano personali/)).toBeInTheDocument();
  });

  it('explains diary sharing to existing house members', () => {
    useHouseStore.setState({
      state: {
        house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' },
        members: [{ userId: user.id, email: user.email, displayName: null, role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }],
      },
    });
    render(<MemoryRouter><HousePage /></MemoryRouter>);

    expect(screen.getByText(/diario delle cene.*ricette confermate dal diario.*condivisi/i)).toBeInTheDocument();
    expect(screen.getByText(/bozze AI.*non confermate.*personali/i)).toBeInTheDocument();
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
