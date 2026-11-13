import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getAllIngredients } from '@ikuck/shared/ingredients';
import { usePantryStore } from '../store/localPantryStore';

export async function choosePlanRecipe(button: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  act(() => usePantryStore.setState({ stapleIds: getAllIngredients().map(ingredient => ingredient.id), hasHydrated: true }));
  await user.click(button);
  await user.click(await screen.findByRole('button', { name: /scegli dalla dispensa/i }));
  const alternatives = await screen.findByRole('region', { name: 'Alternative dalla dispensa' });
  const choices = await within(alternatives).findAllByRole('button');
  await user.click(choices[0]);
  await user.click(await screen.findByRole('button', { name: 'Usa per questo giorno' }));
}
