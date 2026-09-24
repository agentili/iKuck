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
