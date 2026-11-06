import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { INGREDIENTS } from '@ikuck/shared/ingredients';
import StaplesPanel from './StaplesPanel';

const salt = INGREDIENTS.find((ingredient) => ingredient.label === 'Sale');
if (salt === undefined) throw new Error('Expected Sale to be present in the ingredient catalog');

describe('StaplesPanel', () => {
  it('keeps choices collapsed until requested and exposes the active selection', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<StaplesPanel stapleIds={[salt.id]} onToggle={onToggle} />);

    const summary = screen.getByText('Ingredienti di base', { exact: true }).closest('summary')!;
    const disclosure = summary.closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure).toHaveClass('ik-disclosure');
    expect(summary).toHaveTextContent('1 attivi');

    await user.click(summary);
    const checkbox = screen.getByRole('checkbox', { name: 'Sale' });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith(salt.id);
  });
});
