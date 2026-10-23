import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import RecipeCard from './RecipeCard';

const renderCard = (ui: JSX.Element) =>
  render(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>);

const baseProps = {
  variant: 'salvata' as const,
  title: 'Lasagne al forno',
  openHref: '/recipes/saved-lasagne',
  openAriaLabel: 'Apri Lasagne al forno',
};

describe('RecipeCard', () => {
  it('rende titolo, badge e link apri per una ricetta salvata', () => {
    renderCard(<RecipeCard {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();
    expect(screen.getByText('Salvata')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Apri Lasagne al forno' });
    expect(link).toHaveAttribute('href', '/recipes/saved-lasagne');
  });

  it('usa la badge AI per le ricette generate', () => {
    renderCard(<RecipeCard variant="ai" title="Orata al forno" />);

    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('usa la badge Catalogo per le ricette del catalogo', () => {
    renderCard(<RecipeCard variant="catalogo" title="Pollo al limone" openHref="/recipes/pollo-al-limone" />);

    expect(screen.getByText('Catalogo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri Pollo al limone' })).toHaveAttribute('href', '/recipes/pollo-al-limone');
  });

  it('mostra e nasconde i dettagli tramite il toggle (stato gestito dal genitore)', () => {
    function Wrapper() {
      const [expanded, setExpanded] = useState(false);
      return (
        <RecipeCard
          {...baseProps}
          ingredients={[{ name: 'Sfoglie', amount: '250 g' }, { name: 'Besciamella' }]}
          showIngredientAmounts
          steps={['Stendi le sfoglie.', 'Cuoci in forno a 180 gradi per 30 minuti.']}
          onToggle={() => setExpanded((current) => !current)}
          isExpanded={expanded}
          detailsId="library-recipe-details-saved-lasagne"
        />
      );
    }
    renderCard(<Wrapper />);

    const toggle = screen.getByRole('button', { name: 'Mostra dettagli' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Sfoglie')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Nascondi dettagli');
    expect(screen.getByText('Sfoglie', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('250 g')).toBeInTheDocument();
    expect(screen.getByText('Cuoci in forno a 180 gradi per 30 minuti.')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Mostra dettagli');
    expect(screen.queryByText('Sfoglie', { exact: true })).not.toBeInTheDocument();
  });

  it('omette i dettagli e il toggle quando non sono forniti', () => {
    renderCard(
      <RecipeCard variant="catalogo" title="Pollo al limone" description="Descrizione." openHref="/recipes/pollo-al-limone" />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Ingredienti')).not.toBeInTheDocument();
    expect(screen.getByText('Descrizione.')).toBeInTheDocument();
  });

  it('mostra le quantità degli ingredienti solo quando richiesto', () => {
    function Harness({ amounts }: { amounts: boolean }) {
      const [expanded, setExpanded] = useState(false);
      return (
        <RecipeCard
          {...baseProps}
          ingredients={[{ name: 'Sfoglie', amount: '250 g' }]}
          showIngredientAmounts={amounts}
          onToggle={() => setExpanded((current) => !current)}
          isExpanded={expanded}
          detailsId="details"
        />
      );
    }

    const { rerender } = renderCard(<Harness amounts={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mostra dettagli' }));
    expect(screen.getByText('250 g')).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Harness amounts={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('250 g')).not.toBeInTheDocument();
  });
});
