import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage, RecipeData } from './types';

const timestamp = new Date('2026-11-02T08:05:00.000Z');

const recipe: RecipeData = {
  id: 'recipe-123',
  title: 'Risotto alle verdure',
  emoji: '🥣',
  time: '25 min',
  servings: 2,
  tags: ['vegetariana', 'veloce'],
  image: '/recipes/risotto.webp',
  description: 'Un risotto cremoso con le verdure di stagione.',
  ingredients: [{ name: 'riso', amount: '160 g' }],
  steps: ['Tosta il riso.', 'Aggiungi il brodo poco alla volta.'],
  diets: ['vegetarian'],
  allergens: [],
};

const recipeMessage: ChatMessage = {
  id: 'recipe-message',
  role: 'assistant',
  type: 'recipe',
  timestamp,
  recipe,
};

describe('MessageBubble', () => {
  it('preserves long assistant text, line breaks, timestamp, and semantic surface tokens', () => {
    const content = `${'Un messaggio dettagliato di Chef. '.repeat(24)}\nSecondo paragrafo senza troncamenti.`;
    const message: ChatMessage = { id: 'assistant-1', role: 'assistant', type: 'text', timestamp, content };

    const { container } = render(<MessageBubble message={message} />);

    const text = screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === content);
    const bubble = text.closest('.chat-bubble-assistant');
    const time = container.querySelector('time');

    expect(text.textContent).toBe(content);
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(bubble).toHaveClass('max-w-[85%]');
    expect(bubble).toHaveStyle({ backgroundColor: 'var(--ik-porcelain)', color: 'var(--ik-ink)' });
    expect(time).toHaveAttribute('datetime', timestamp.toISOString());
    expect(time).toHaveTextContent(timestamp.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
  });

  it('renders user messages with the user treatment and optimistic state', () => {
    const message: ChatMessage = {
      id: 'user-1',
      role: 'user',
      type: 'text',
      timestamp,
      content: 'Mi suggerisci una cena semplice?',
      isOptimistic: true,
    };

    const { container } = render(<MessageBubble message={message} />);
    const bubble = screen.getByText(message.content).closest('.chat-bubble-user');

    expect(bubble).toHaveClass('ml-auto', 'max-w-[85%]');
    expect(bubble).toHaveStyle({ backgroundColor: 'var(--ik-basil-dark)', opacity: '0.7' });
    expect(container.querySelector('time')).toHaveAttribute('datetime', timestamp.toISOString());
  });

  it('keeps recipe actions attached to the exact recipe and supports opening the recipe card', async () => {
    const user = userEvent.setup();
    const onStartCooking = vi.fn();
    const onSaveRecipe = vi.fn();
    const onViewRecipe = vi.fn();
    render(
      <MessageBubble
        message={recipeMessage}
        onStartCooking={onStartCooking}
        onSaveRecipe={onSaveRecipe}
        onViewRecipe={onViewRecipe}
      />,
    );

    const article = screen.getByRole('article', { name: `Ricetta: ${recipe.title}` });
    await user.click(article);
    expect(onViewRecipe).toHaveBeenCalledWith(recipe);

    await user.click(screen.getByRole('button', { name: 'Cuciniamo' }));
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    expect(onStartCooking).toHaveBeenCalledWith(recipe);
    expect(onSaveRecipe).toHaveBeenCalledWith(recipe);
    expect(onStartCooking).toHaveBeenCalledOnce();
    expect(onSaveRecipe).toHaveBeenCalledOnce();
  });

  it.each(['Enter', ' '])('opens the recipe card when the card itself receives %s keydown', (key) => {
    const onViewRecipe = vi.fn();
    render(<MessageBubble message={recipeMessage} onViewRecipe={onViewRecipe} />);

    fireEvent.keyDown(screen.getByRole('article', { name: `Ricetta: ${recipe.title}` }), { key });

    expect(onViewRecipe).toHaveBeenCalledWith(recipe);
  });

  it.each(['Enter', ' '])('does not open the recipe card when a nested action receives %s keydown', (key) => {
    const onViewRecipe = vi.fn();
    render(<MessageBubble message={recipeMessage} onViewRecipe={onViewRecipe} />);

    const startButton = screen.getByRole('button', { name: 'Cuciniamo' });
    fireEvent.keyDown(startButton, { key });

    expect(onViewRecipe).not.toHaveBeenCalled();
  });

  it('exposes editable draft ingredients and steps and preserves explicit save and discard actions', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn();
    const onDiscardDraft = vi.fn();
    const draft: ChatMessage = { id: 'draft-message', role: 'assistant', type: 'draft', timestamp, recipe };
    render(<MessageBubble message={draft} onSaveDraft={onSaveDraft} onDiscardDraft={onDiscardDraft} />);

    expect(screen.getByRole('article', { name: `Anteprima ricetta: ${recipe.title}` })).toBeVisible();
    expect(screen.getByText('160 g riso')).toBeVisible();
    expect(screen.getByText('Tosta il riso.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Salva ricetta' }));
    await user.click(screen.getByRole('button', { name: 'Scarta' }));

    expect(onSaveDraft).toHaveBeenCalledWith(recipe);
    expect(onDiscardDraft).toHaveBeenCalledWith(recipe.id);
  });

  it('exposes errors as alerts and runs the supplied recovery action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const message: ChatMessage = {
      id: 'error-1',
      role: 'assistant',
      type: 'error',
      timestamp,
      content: 'La ricetta non è disponibile.',
      action: { label: 'Riprova', onAction },
    };
    render(<MessageBubble message={message} />);

    expect(screen.getByRole('alert')).toHaveTextContent(message.content);
    await user.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('announces the typing state accessibly', () => {
    const message: ChatMessage = { id: 'typing', role: 'assistant', type: 'typing', timestamp };
    render(<MessageBubble message={message} />);

    expect(screen.getByRole('status')).toHaveTextContent('Chef sta pensando...');
  });
});
