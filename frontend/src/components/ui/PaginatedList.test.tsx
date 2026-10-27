import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import PaginatedList from './PaginatedList';
afterEach(cleanup);
it('limits the page, moves forward and resets when the collection changes', async () => {
  const user = userEvent.setup();
  const list = (count: number) => <MemoryRouter><PaginatedList>{Array.from({ length: count }, (_, index) => <p key={index}>Ricetta {index + 1}</p>)}</PaginatedList></MemoryRouter>;
  const { rerender } = render(list(41));
  expect(screen.queryByText('Ricetta 21')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Avanti' }));
  expect(screen.getByText('Ricetta 21')).toBeInTheDocument();
  expect(screen.queryByText('Ricetta 1')).not.toBeInTheDocument();
  rerender(list(2));
  expect(screen.getByText('Ricetta 1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Avanti' })).toBeDisabled();
});
it('supports a configurable page size', async () => {
  render(<MemoryRouter><PaginatedList>{Array.from({ length: 25 }, (_, index) => <p key={index}>Ingrediente {index + 1}</p>)}</PaginatedList></MemoryRouter>);
  await userEvent.selectOptions(screen.getByRole('combobox'), '10');
  expect(screen.queryByText('Ingrediente 11')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1 di 3');
});
it('uses a named navigation and keeps pagination valid inside a list', () => {
  render(<ul><PaginatedList list label="Paginazione attività"><li>Attività</li></PaginatedList></ul>);
  expect(screen.getByRole('navigation', { name: 'Paginazione attività' }).parentElement?.tagName).toBe('LI');
});
