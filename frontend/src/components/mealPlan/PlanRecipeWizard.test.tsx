import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import PlanRecipeWizard from './PlanRecipeWizard';
import { DEFAULT_DIET_PROFILE } from '../../domain/dietary';
import { RECIPES } from '../../domain/recipes';

const generated: GeneratedRecipe = { id: 'new-ai-recipe', source: 'ai', title: 'Riso semplice', description: 'Un piatto caldo', ingredients: [{ name: 'Riso', amount: '150 g' }], steps: ['Cuoci il riso.'], diets: ['omnivore', 'vegan'], allergens: [], createdAt: '2026-11-12T12:00:00Z', updatedAt: '2026-11-12T12:00:00Z' };
vi.mock('../ai/AiRecipePanel', () => ({ default: ({ onRecipeProposed, dishDescription, generationReady }: { onRecipeProposed: (recipe: GeneratedRecipe) => void; dishDescription: string; generationReady: boolean }) => <button disabled={!generationReady || !dishDescription.trim()} onClick={() => onRecipeProposed(generated)}>Genera ricetta AI</button> }));
const props = () => ({ date: '2026-11-13', label: 'Venerdì 13 novembre', scope: 'guest' as const, currentId: null, recipes: [...RECIPES], availableIds: RECIPES[0].ingredients.map(ingredient => ingredient.ingredientId), ready: true, profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-11-12T12:00:00Z' }, user: null, csrfToken: null, onClose: vi.fn(), onConfirm: vi.fn().mockResolvedValue(undefined) });

describe('PlanRecipeWizard', () => {
  it('reviews an available alternative and writes only on confirmation', async () => {
    const user = userEvent.setup();
    const input = props();
    render(<PlanRecipeWizard {...input} />);
    await user.click(screen.getByRole('button', { name: /scegli dalla dispensa/i }));
    const alternatives = screen.getByRole('region', { name: 'Alternative dalla dispensa' });
    expect(within(alternatives).queryByText('Carbonara semplice')).not.toBeInTheDocument();
    await user.click(within(alternatives).getByRole('button', { name: /pollo al limone/i }));
    expect(input.onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Usa per questo giorno' }));
    expect(input.onConfirm).toHaveBeenCalledWith(RECIPES[0], undefined);
    expect(input.onClose).toHaveBeenCalledOnce();
  });

  it('offers creation when there are no complete alternatives and cancels without writing', async () => {
    const user = userEvent.setup();
    const input = { ...props(), availableIds: [] };
    render(<PlanRecipeWizard {...input} />);
    await user.click(screen.getByRole('button', { name: /scegli dalla dispensa/i }));
    expect(screen.getByText(/nessun’altra ricetta compatibile/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(input.onConfirm).not.toHaveBeenCalled();
    expect(input.onClose).toHaveBeenCalledOnce();
  });

  it('confirms the generated recipe without extra fields and preserves its ID on retry', async () => {
    const user = userEvent.setup();
    const input = { ...props(), availableIds: [] };
    input.onConfirm.mockRejectedValueOnce(new Error('Ricetta conservata. Assegnazione non riuscita.'));
    render(<PlanRecipeWizard {...input} />);
    await user.click(screen.getByRole('button', { name: /crea con ai/i }));
    expect(screen.getByRole('button', { name: 'Genera ricetta AI' })).toBeDisabled();
    await user.type(screen.getByLabelText('Descrizione del piatto'), 'Un risotto cremoso al limone');
    await user.clear(screen.getByLabelText('Numero di porzioni'));
    await user.type(screen.getByLabelText('Numero di porzioni'), '4');
    await user.click(screen.getByRole('button', { name: 'Genera ricetta AI' }));
    expect(input.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: generated.title })).toBeVisible();
    expect(screen.getByText('4 porzioni')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByText('Ingredienti e dosi')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/durata|dose|ingrediente/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Salva nel ricettario e usa' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Assegnazione non riuscita');
    expect(input.onClose).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole('button', { name: 'Salva nel ricettario e usa' }));
    await waitFor(() => expect(input.onClose).toHaveBeenCalled());
    const first = input.onConfirm.mock.calls[0][1];
    const second = input.onConfirm.mock.calls[1][1];
    expect(first).toMatchObject({ id: generated.id, title: generated.title, durationMinutes: null, servings: 4 });
    expect(first.ingredients).toEqual([expect.objectContaining(generated.ingredients[0])]);
    expect(first.steps).toEqual(generated.steps);
    expect(second.id).toBe(first.id);
  });
});
