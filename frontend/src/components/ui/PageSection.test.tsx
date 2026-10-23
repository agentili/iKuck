import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PageSection from './PageSection';

describe('PageSection', () => {
  it('rende eyebrow, titolo H2, descrizione e figli', () => {
    render(
      <PageSection eyebrow="Dal diario" title="Le tue ricette salvate" titleId="library-recipes-title" description="Descrizione di prova.">
        <p>Contenuto della sezione</p>
      </PageSection>,
    );

    const section = screen.getByRole('region');
    expect(section).toHaveAttribute('aria-labelledby', 'library-recipes-title');
    expect(screen.getByText('Dal diario')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Le tue ricette salvate' })).toHaveAttribute('id', 'library-recipes-title');
    expect(screen.getByText('Descrizione di prova.')).toBeInTheDocument();
    expect(screen.getByText('Contenuto della sezione')).toBeInTheDocument();
  });

  it('omette eyebrow e descrizione quando non forniti e rende l\'azione', () => {
    render(
      <PageSection title="Solo titolo">
        <button type="button">Aziona</button>
      </PageSection>,
    );

    expect(screen.queryByText('Dal diario')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Solo titolo' })).toBeInTheDocument();
  });
});
