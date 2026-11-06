import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProfileModal } from './ProfileModal';
import { useAuthStore } from '../../auth/authStore';
import { saveColorThemePreference } from '../../domain/colorTheme';

const ProfileModalHarness = () => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setIsOpen(true)}>Apri profilo</button>
      <ProfileModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </MemoryRouter>
  );
};

describe('ProfileModal shared overlay', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    document.documentElement.dataset.theme = 'light';
    useAuthStore.setState({ user: null, connection: 'unknown' });
  });

  it('uses semantic overlay and surface tokens with consistent dividers', async () => {
    const user = userEvent.setup();
    render(<ProfileModalHarness />);
    await user.click(screen.getByRole('button', { name: 'Apri profilo' }));

    const dialog = screen.getByRole('dialog', { name: 'Profilo' });
    expect(dialog.querySelector('.ik-modal-backdrop')).not.toBeNull();
    expect(dialog.querySelector('.ik-modal-surface')).not.toBeNull();
    for (const divider of dialog.querySelectorAll('.border-b')) {
      expect(divider).toHaveClass('border-[var(--ik-border)]');
    }
  });

  it('links the account menu to the real House route', async () => {
    const user = userEvent.setup();
    render(<ProfileModalHarness />);
    await user.click(screen.getByRole('button', { name: 'Apri profilo' }));

    expect(screen.getByRole('link', { name: 'Casa e condivisione' })).toHaveAttribute('href', '/house');
  });

  it('traps keyboard focus and restores it to the opener when closed', async () => {
    const user = userEvent.setup();
    render(<ProfileModalHarness />);
    const opener = screen.getByRole('button', { name: 'Apri profilo' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Profilo' });
    const closeButton = within(dialog).getByRole('button', { name: 'Chiudi' });
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Tema scuro' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Profilo' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
