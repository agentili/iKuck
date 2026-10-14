import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DinnerConsumptionIngredient } from '@ikuck/shared/pantryConsumption';
import type { PantryLot } from '@ikuck/shared/contracts';
import DinnerConsumptionSelection from './DinnerConsumptionSelection';

const stock: PantryLot = {
  id: 'pasta-lot', ingredientId: 'pasta', label: 'Pasta', known: true,
  quantity: 100, unit: 'g', expiresAt: null,
  createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z',
};

function FreeTextSelectionHarness() {
  const [ingredients, setIngredients] = useState<DinnerConsumptionIngredient[]>([]);
  const [noneUsed, setNoneUsed] = useState(false);
  return (
    <DinnerConsumptionSelection
      mode="free-text"
      ingredients={ingredients}
      lots={[stock]}
      servings={2}
      noneUsed={noneUsed}
      onIngredientsChange={setIngredients}
      onNoneUsedChange={setNoneUsed}
    />
  );
}

describe('DinnerConsumptionSelection', () => {
  it('requires an explicit no-pantry choice or an identified ingredient with a quantity', async () => {
    const user = userEvent.setup();
    render(<FreeTextSelectionHarness />);

    const noIngredientChoice = screen.getByRole('checkbox', { name: 'Nessun ingrediente della dispensa utilizzato' });
    expect(noIngredientChoice).not.toBeChecked();
    await user.click(noIngredientChoice);
    expect(noIngredientChoice).toBeChecked();
    await user.click(noIngredientChoice);
    expect(noIngredientChoice).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Aggiungi ingrediente utilizzato' }));
    expect(screen.getByRole('checkbox', { name: 'Nessun ingrediente della dispensa utilizzato' })).not.toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ingrediente usato 1' }), 'pasta');
    await user.type(screen.getByRole('textbox', { name: 'Quantità per porzione di Pasta' }), '80 g');

    expect(screen.getByText(/Ne userai 100 g; mancano 60 g rispetto ai 160 g richiesti/i)).toBeVisible();
  });
});
