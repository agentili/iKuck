import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import EmptyState from './EmptyState';

const renderEmptyState = (ui: JSX.Element) =>
  render(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>);

describe('EmptyState', () => {
  it('rende titolo, testo e azione opzionale', () => {
    renderEmptyState(
      <EmptyState
        title="Nessuna ricetta trovata"
        text="Nessuna ricetta trovata per «xyz». Prova un altro titolo o ingrediente."
        action={{ label: 'Trova ricette', href: '/', ariaLabel: 'Trova ricette' }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Nessuna ricetta trovata' })).toBeInTheDocument();
    expect(
      screen.getByText('Nessuna ricetta trovata per «xyz». Prova un altro titolo o ingrediente.'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Trova ricette' });
    expect(link).toHaveAttribute('href', '/');
  });

  it('rende solo il testo quando il titolo è omesso', () => {
    renderEmptyState(<EmptyState text="Nessuna ricetta salvata ancora." />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('Nessuna ricetta salvata ancora.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('omette l\'azione quando non fornita', () => {
    renderEmptyState(<EmptyState title="Titolo" text="Testo" />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
