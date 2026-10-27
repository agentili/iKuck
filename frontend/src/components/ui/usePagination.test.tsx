import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setActiveDataScope } from '../../sync/scopeContext';
import { usePagination } from './usePagination';

function Results({ identity = 'all', count = 41 }: { identity?: string; count?: number }) {
  const { visible, controls } = usePagination(Array.from({ length: count }, (_, i) => i + 1), identity);
  return <>{visible.map((item) => <p key={item}>Risultato {item}</p>)}{controls}</>;
}

beforeEach(() => setActiveDataScope('guest'));
afterEach(cleanup);

it('remembers filter resets even when returning to the previous filter', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Results />);
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  rerender(<Results identity="filtered" />);
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1 di 3');
  rerender(<Results />);
  expect(screen.getByText('Risultato 1')).toBeVisible();
});

it('clamps an emptied last page and does not restore it when results grow', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Results />);
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  rerender(<Results count={40} />);
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 2 di 2');
  expect(screen.getByText('Risultato 21')).toBeVisible();
  rerender(<Results count={41} />);
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 2 di 3');
  rerender(<Results count={0} />);
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1 di 1 · 0 elementi');
  expect(screen.getByRole('button', { name: 'Indietro' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Avanti' })).toBeDisabled();
});

it('resets on scope changes and page size changes while preserving the selected size', async () => {
  const user = userEvent.setup();
  render(<Results />);
  expect(screen.getByRole('combobox')).toHaveValue('20');
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['10', '20', '40']);
  await user.selectOptions(screen.getByRole('combobox'), '10');
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  act(() => setActiveDataScope('house:other'));
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1 di 5');
  expect(screen.getByRole('combobox')).toHaveValue('10');
  act(() => setActiveDataScope('guest'));
  expect(screen.getByText('Risultato 1')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  await user.selectOptions(screen.getByRole('combobox'), '40');
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1 di 2');
  expect(screen.getByText('Risultato 40')).toBeVisible();
});
