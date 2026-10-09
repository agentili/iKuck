import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RecipeImage from './RecipeImage';

describe('RecipeImage', () => {
  it('labels an illustrative local photo and preserves fixed image dimensions', () => {
    render(<RecipeImage recipeId="uova-al-pomodoro" recipeTitle="Uova al pomodoro" />);
    const image = screen.getByRole('img', { name: /foto illustrativa/i });
    expect(image).toHaveAttribute('src', '/recipe-images/uova-al-pomodoro.webp');
    expect(image).toHaveAttribute('width', '720');
    expect(screen.getByText(/Foto illustrativa · Alex Bayev · Unsplash/)).toBeInTheDocument();
  });

  it('shows a truthful fallback for absent or broken local assets', () => {
    const { rerender } = render(<RecipeImage recipeId="nonexistent-recipe" recipeTitle="Ricetta personale" />);
    expect(screen.getByRole('img', { name: 'Foto non disponibile per Ricetta personale' })).toBeInTheDocument();
    rerender(<RecipeImage recipeId="uova-al-pomodoro" recipeTitle="Uova al pomodoro" />);
    fireEvent.error(screen.getByRole('img', { name: /foto illustrativa/i }));
    expect(screen.getByRole('img', { name: 'Foto non disponibile per Uova al pomodoro' })).toBeInTheDocument();
  });
});
