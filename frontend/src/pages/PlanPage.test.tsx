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

  it('keeps local guest proposals visibly distinct from shared plans', async () => {
    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/salvato su questo dispositivo/i)).toBeVisible());
    expect(screen.queryByText(/piano condiviso/i)).not.toBeInTheDocument();
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
