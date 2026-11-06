import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimplifiedHeader } from './SimplifiedHeader';
import { useAuthStore } from '../../auth/authStore';
import { saveColorThemePreference } from '../../domain/colorTheme';

vi.mock('../../config/features', () => ({ isSimplifiedHeader: () => true }));

describe('SimplifiedHeader', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    document.documentElement.dataset.theme = 'light';
    useAuthStore.setState({ user: null, connection: 'unknown' });
  });

  it('renders semantic shared chrome and a toggleable profile disclosure', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SimplifiedHeader /></MemoryRouter>);

    expect(screen.getByRole('banner')).toHaveClass('ik-app-header');
    const profileButton = screen.getByRole('button', { name: 'Profilo' });
    expect(profileButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(profileButton);

    expect(profileButton).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('link', { name: /^Profilo$/ }).closest('nav')?.parentElement;
    expect(menu).toHaveClass('bg-[var(--ik-porcelain)]', 'border-[var(--ik-sage)]');
    expect(screen.getByRole('link', { name: /^Profilo$/ })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('link', { name: /Casa/ })).toHaveAttribute('href', '/house');
  });

  it('closes the profile disclosure with Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SimplifiedHeader /></MemoryRouter>);

    const profileButton = screen.getByRole('button', { name: 'Profilo' });
    await user.click(profileButton);
    await user.tab();
    expect(screen.getByRole('link', { name: /^Profilo$/ })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(profileButton).toHaveAttribute('aria-expanded', 'false');
    expect(profileButton).toHaveFocus();
  });
});
