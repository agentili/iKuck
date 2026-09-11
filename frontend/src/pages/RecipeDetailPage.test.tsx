import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import RecipeDetailPage from './RecipeDetailPage';

const renderRoute = (path: string) => render(
  <MemoryRouter
    initialEntries={[path]}
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
  >
    <Routes>
      <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
    </Routes>
  </MemoryRouter>,
);

describe('RecipeDetailPage integration', () => {
  it('loads a recipe directly from its stable url', () => {
    renderRoute('/recipes/pollo-al-limone');

    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ingredienti' })).toBeInTheDocument();
    expect(screen.getByText('Petto di pollo')).toBeInTheDocument();
    expect(screen.getByText('300 g')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preparazione' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(6);
  });

  it('marks optional ingredients in the cooking details', () => {
    renderRoute('/recipes/pasta-tonno-pomodoro');

    expect(screen.getByText('1 spicchio · facoltativo')).toBeInTheDocument();
  });

  it('shows a recoverable state for an unknown recipe id', () => {
    renderRoute('/recipes/not-real');

    expect(screen.getByRole('heading', { name: 'Ricetta non trovata' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Torna alla dispensa' })).toHaveAttribute('href', '/');
  });
});
