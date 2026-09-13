import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PantryLotEditor from './PantryLotEditor';

describe('PantryLotEditor', () => {
  it('keeps presence-only details valid', () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<PantryLotEditor onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Salva dettagli' }));

    expect(onSubmit).toHaveBeenCalledWith({ quantity: null, unit: null, expiresAt: null });
  });

  it('requires a unit when a quantity is entered', () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<PantryLotEditor onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Quantità del lotto'), { target: { value: '320' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva dettagli' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Scegli l’unità di misura');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits quantity, unit and expiry details', () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<PantryLotEditor onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Quantità del lotto'), { target: { value: '320' } });
    fireEvent.change(screen.getByLabelText('Unità di misura'), { target: { value: 'g' } });
    fireEvent.change(screen.getByLabelText('Data di scadenza'), { target: { value: '2026-09-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva dettagli' }));

    expect(onSubmit).toHaveBeenCalledWith({ quantity: 320, unit: 'g', expiresAt: '2026-09-20' });
  });
});
