import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import DietFiltersPanel from './DietFiltersPanel';

const profile: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

describe('DietFiltersPanel', () => {
  it('starts collapsed and summarizes active filters before expansion', async () => {
    const user = userEvent.setup();
    render(
      <DietFiltersPanel
        profile={{ ...profile, diet: 'vegan', excludedAllergens: ['fish'], nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: null } }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const summary = screen.getByText('Filtri alimentari');
    const details = summary.closest('details');

    expect(details).not.toBeNull();
    if (details === null) return;
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('3 attivi')).toBeInTheDocument();

    await user.click(summary);

    expect(details).toHaveAttribute('open');
    expect(screen.getByLabelText('Dieta')).toHaveValue('vegan');
  });

  it('exposes an accessible diet selector, allergen checkboxes and estimate guidance', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DietFiltersPanel profile={profile} onChange={onChange} onReset={vi.fn()} />);

    expect(screen.getByLabelText('Dieta')).toHaveValue('omnivore');
    expect(screen.getByLabelText('Escludi glutine')).toBeInTheDocument();
    expect(screen.getByLabelText('Escludi pesce')).toBeInTheDocument();
    expect(screen.getByText(/allergeni sono esclusioni bloccanti/i)).toBeVisible();
    expect(screen.getByText(/valori nutrizionali sono stime/i)).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Dieta'), 'vegan');
    await user.click(screen.getByLabelText('Escludi glutine'));
    fireEvent.change(screen.getByLabelText('Calorie massime per porzione'), { target: { value: '600' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ diet: 'vegan' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ excludedAllergens: ['gluten'] }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: null } }));
  });

  it('calls reset without triggering a search itself', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<DietFiltersPanel profile={profile} onChange={vi.fn()} onReset={onReset} />);

    await user.click(screen.getByRole('button', { name: 'Ripristina filtri' }));

    expect(onReset).toHaveBeenCalledOnce();
  });
});
