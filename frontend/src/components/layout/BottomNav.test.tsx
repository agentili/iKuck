import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomNav } from './BottomNav';

// The bottom navigation only renders when the build-time Sous-Chef flag is on,
// so the flag module is stubbed: this suite asserts the flag-ON shell contract.
vi.mock('../../config/features', () => ({ isBottomNav: () => true }));

const expectedDestinations = [
  { label: 'Dispensa', path: '/pantry' },
  { label: 'Spesa', path: '/shopping-list' },
  { label: 'Chef', path: '/' },
  { label: 'Piano', path: '/plan' },
  { label: 'Ricette', path: '/recipes' },
] as const;

describe('BottomNav (shell Sous-Chef)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers exactly the five T02 destinations, in order', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole('navigation', { name: 'Navigazione principale' });
    const links = navigation.querySelectorAll('a');
    expect(links).toHaveLength(5);
    expect(
      Array.from(links).map((link) => ({
        label: link.getAttribute('aria-label') ?? '',
        path: link.getAttribute('href'),
      })),
    ).toEqual(expectedDestinations.map(({ label, path }) => ({ label, path })));
  });

  it('keeps every destination reachable as a real link', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav />
      </MemoryRouter>,
    );

    for (const { label, path } of expectedDestinations) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', path);
    }
  });

  it('drops the retired «Cerca» and «Salvate» entries introduced by the prototype', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: 'Cerca' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Salvate' })).not.toBeInTheDocument();
  });

  it('marks the current destination with aria-current', () => {
    render(
      <MemoryRouter initialEntries={['/pantry']}>
        <BottomNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Dispensa' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Chef' })).not.toHaveAttribute('aria-current');
  });
});