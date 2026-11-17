import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PlanPage from './PlanPage';

describe('PlanPage', () => {
  it('shows seven consecutive guest plan days starting tomorrow', async () => {
    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(7));
    expect(screen.getByRole('heading', { level: 1, name: 'Piano settimanale' })).toBeInTheDocument();
  });

  it('shows the guest plan without the sharing and timezone banner', async () => {
    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('list', { name: 'Pasti da domani' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Stato della condivisione' })).not.toBeInTheDocument();
    expect(screen.queryByText(/salvato su questo dispositivo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Fuso:/)).not.toBeInTheDocument();
  });

  it('does not duplicate navigation links at the bottom', () => {
    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: /torna al chef/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /lista della spesa/i })).not.toBeInTheDocument();
  });
});
