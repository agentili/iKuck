import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotFoundPage from './NotFoundPage';

describe('NotFoundPage', () => {
  it('explains that a generic page is missing and focuses the recovery content', () => {
    render(
      <MemoryRouter initialEntries={['/missing-page']}>
        <NotFoundPage resource="page" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Pagina non trovata' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Torna alla home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('keeps the recipe-specific recovery copy', () => {
    render(
      <MemoryRouter initialEntries={['/recipes/not-real']}>
        <NotFoundPage resource="recipe" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Ricetta non trovata' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Torna alle ricette' })).toHaveAttribute('href', '/');
  });
});
