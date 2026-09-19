import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PantryLot } from '@ikuck/shared/contracts';
import PantryLotsPanel from './PantryLotsPanel';

const ingredients = [{ id: 'pasta', label: 'Pasta', known: true }];
const localDateInDays = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const lots: PantryLot[] = [
  {
    id: 'lot-1', ingredientId: 'pasta', label: 'Pasta', known: true,
    quantity: 500, unit: 'g', expiresAt: localDateInDays(2),
    createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
  },
  {
    id: 'lot-2', ingredientId: 'pasta', label: 'Pasta', known: true,
    quantity: 1, unit: 'kg', expiresAt: null,
    createdAt: '2026-09-13T11:00:00.000Z', updatedAt: '2026-09-13T11:00:00.000Z',
  },
];

describe('PantryLotsPanel', () => {
  it('starts collapsed and summarizes the active lot count', async () => {
    const user = userEvent.setup();
    render(<PantryLotsPanel ingredients={ingredients} lots={lots} onAddLot={vi.fn()} onRemoveLot={vi.fn()} onUpdateLot={vi.fn()} />);

    const summary = screen.getByText('Dettagli lotti');
    const details = summary.closest('details');

    expect(details).not.toBeNull();
    if (details === null) return;
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('2 lotti')).toBeInTheDocument();

    await user.click(summary);

    expect(details).toHaveAttribute('open');
  });

  it('shows aggregated quantities, lot count and expiry status when expanded', async () => {
    const user = userEvent.setup();
    render(<PantryLotsPanel ingredients={ingredients} lots={lots} onAddLot={vi.fn()} onRemoveLot={vi.fn()} onUpdateLot={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Dettagli lotti' })).toBeVisible();
    await user.click(screen.getByText('Dettagli lotti'));
    expect(screen.getByText(/Totale: 1500 g/)).toBeVisible();
    expect(screen.getAllByText(/Scade presto/)).toHaveLength(2);
  });

  it('opens a new lot editor and saves its details', () => {
    const onAddLot = vi.fn().mockReturnValue('lot-3');
    render(<PantryLotsPanel ingredients={ingredients} lots={lots} onAddLot={onAddLot} onRemoveLot={vi.fn()} onUpdateLot={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi lotto' }));
    fireEvent.change(screen.getByLabelText('Quantità del lotto'), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText('Unità di misura'), { target: { value: 'g' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva dettagli' }));

    expect(onAddLot).toHaveBeenCalledWith({ ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 250, unit: 'g', expiresAt: null });
  });

  it('removes one lot with an accessible action', () => {
    const onRemoveLot = vi.fn();
    render(<PantryLotsPanel ingredients={ingredients} lots={lots} onAddLot={vi.fn()} onRemoveLot={onRemoveLot} onUpdateLot={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rimuovi lotto 1 di Pasta' }));

    expect(onRemoveLot).toHaveBeenCalledWith('lot-1');
  });

  it('restores a removed lot from the undo toast', async () => {
    const user = userEvent.setup();
    const onRestoreLot = vi.fn().mockReturnValue(true);
    render(<PantryLotsPanel ingredients={ingredients} lots={lots} onAddLot={vi.fn()} onRemoveLot={vi.fn()} onRestoreLot={onRestoreLot} onUpdateLot={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Rimuovi lotto 1 di Pasta' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onRestoreLot).toHaveBeenCalledWith(lots[0]);
  });
});
