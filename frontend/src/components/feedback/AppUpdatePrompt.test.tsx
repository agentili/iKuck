import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppUpdatePrompt from './AppUpdatePrompt';

describe('AppUpdatePrompt', () => {
  it('exposes a non-blocking update prompt with explicit actions', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onLater = vi.fn();

    render(<AppUpdatePrompt status="available" onUpdate={onUpdate} onLater={onLater} />);

    expect(screen.getByText('Aggiornamento disponibile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aggiorna ora' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Più tardi' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Più tardi' }));
    await user.click(screen.getByRole('button', { name: 'Aggiorna ora' }));

    expect(onLater).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('does not trigger a reload while the update waits for the user choice', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    render(<AppUpdatePrompt status="available" onUpdate={vi.fn()} onLater={vi.fn()} />);

    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows progress and a recoverable error after update failure', () => {
    const onUpdate = vi.fn();

    const { rerender } = render(
      <AppUpdatePrompt status="updating" onUpdate={onUpdate} onLater={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Aggiornamento in corso' })).toBeDisabled();

    rerender(
      <AppUpdatePrompt
        status="failed"
        errorMessage="Aggiornamento non riuscito."
        onUpdate={onUpdate}
        onLater={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Aggiornamento non riuscito');
    expect(screen.getByText('Aggiornamento non riuscito.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova aggiornamento' })).toBeEnabled();
  });
});
