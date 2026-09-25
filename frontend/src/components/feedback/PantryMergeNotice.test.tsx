import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PantryMergeNotice from './PantryMergeNotice';

const summary = { addedLots: 2, mergedLots: 1, mergedGroups: 1, importedStaples: 3 };

describe('PantryMergeNotice', () => {
  it('shows the automatic merge summary and can be dismissed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<PantryMergeNotice summary={summary} onDismiss={onDismiss} />);

    expect(screen.getByRole('status')).toHaveTextContent('2 elementi aggiunti');
    expect(screen.getByRole('status')).toHaveTextContent('1 duplicato unito');
    expect(screen.getByRole('status')).toHaveTextContent('3 ingredienti di base aggiunti');
    await user.click(screen.getByRole('button', { name: 'Chiudi riepilogo fusione dispensa' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
