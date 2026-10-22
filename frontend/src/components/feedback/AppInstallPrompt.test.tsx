import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppInstallPrompt from './AppInstallPrompt';

const DISMISSED_KEY = 'ikuck-install-prompt-dismissed';

const dispatchBeforeInstallPrompt = (outcome: 'accepted' | 'dismissed') => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.defineProperty(event, 'prompt', { value: prompt, configurable: true });
  Object.defineProperty(event, 'userChoice', {
    value: Promise.resolve({ outcome }),
    configurable: true,
  });
  return { prompt, event };
};

describe('AppInstallPrompt', () => {
  beforeEach(() => {
    localStorage.removeItem(DISMISSED_KEY);
  });

  it('non mostra nulla se l’utente ha già rifiutato l’installazione', () => {
    localStorage.setItem(DISMISSED_KEY, '1');

    render(<AppInstallPrompt />);

    expect(screen.queryByText('Installa iKuck')).not.toBeInTheDocument();
    expect(screen.queryByText('Usa iKuck come app')).not.toBeInTheDocument();
  });

  it('mostra il suggerimento di installazione quando arriva beforeinstallprompt', async () => {
    const { event } = dispatchBeforeInstallPrompt('accepted');

    render(<AppInstallPrompt />);
    window.dispatchEvent(event);

    await screen.findByText('Installa iKuck');
    expect(screen.getByRole('button', { name: /^Installa/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Più tardi' })).toBeInTheDocument();
  });

  it('chiama prompt() e memorizza la scelta quando l’utente installa', async () => {
    const user = userEvent.setup();
    const { prompt, event } = dispatchBeforeInstallPrompt('accepted');

    render(<AppInstallPrompt />);
    window.dispatchEvent(event);

    await screen.findByRole('button', { name: /^Installa/ });
    await user.click(screen.getByRole('button', { name: /^Installa/ }));

    expect(prompt).toHaveBeenCalledOnce();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
    await waitFor(() =>
      expect(screen.queryByText('Installa iKuck')).not.toBeInTheDocument(),
    );
  });

  it('non installa due volte se la scelta viene rifiutata', async () => {
    const user = userEvent.setup();
    const { prompt, event } = dispatchBeforeInstallPrompt('dismissed');

    render(<AppInstallPrompt />);
    window.dispatchEvent(event);

    await screen.findByRole('button', { name: /^Installa/ });
    await user.click(screen.getByRole('button', { name: /^Installa/ }));

    expect(prompt).toHaveBeenCalledOnce();
    expect(localStorage.getItem(DISMISSED_KEY)).not.toBe('1');
    expect(screen.getByRole('button', { name: /^Installa/ })).toBeInTheDocument();
  });
});
