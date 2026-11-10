import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SimplifiedHeader } from './SimplifiedHeader';
import { useAuthStore } from '../../auth/authStore';
import { saveColorThemePreference } from '../../domain/colorTheme';

describe('SimplifiedHeader', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    document.documentElement.dataset.theme = 'light';
    useAuthStore.setState({ user: null, connection: 'unknown' });
  });

  it('renders one profile disclosure without duplicate menu or theme controls', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SimplifiedHeader /></MemoryRouter>);

    expect(screen.getByRole('banner')).toHaveClass('ik-app-header');
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tema (chiaro|scuro)/ })).not.toBeInTheDocument();
    const profileButton = screen.getByRole('button', { name: 'Profilo' });
    expect(profileButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(profileButton);

    expect(profileButton).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('link', { name: /^Profilo$/ }).closest('nav')?.parentElement;
    expect(menu).toHaveClass('bg-[var(--ik-porcelain)]', 'border-[var(--ik-sage)]');
    expect(screen.getByRole('link', { name: /^Profilo$/ })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('link', { name: /Casa/ })).toHaveAttribute('href', '/house');
    expect(screen.queryByRole('button', { name: /Tema (chiaro|scuro)/ })).not.toBeInTheDocument();
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

  it('shows an unverified scope in the recovery header and profile menu', async () => {
    render(<MemoryRouter><SimplifiedHeader scopeUnverified /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Ambito da verificare');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Profilo' }));
    expect(screen.getByText('Ospite · Ambito da verificare')).toBeVisible();
    expect(screen.queryByText(/Personale/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Casa/ })).toHaveAttribute('href', '/house');
  });
});
