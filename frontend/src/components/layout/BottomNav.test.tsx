import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomNav } from './BottomNav';

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

  it('uses semantic palette tokens for the navigation surface and active state', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <BottomNav />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole('navigation', { name: 'Navigazione principale' });
    expect(navigation).toHaveClass('ik-navigation-surface');
    expect(screen.getByRole('link', { name: 'Chef' })).toHaveClass(
      'bg-[var(--ik-sage)]',
      'text-[var(--ik-basil-dark)]',
    );
    expect(screen.getByRole('link', { name: 'Dispensa' })).toHaveClass(
      'text-[var(--ik-ink-muted)]',
      'hover:bg-[var(--ik-sage)]',
    );
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

  it.each(expectedDestinations.map(({ label, path }) => [path, label] as const))(
    'marks the primary destination %s as current', (path, label) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <BottomNav />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    },
  );

  it.each(['/discover', '/saved', '/activity', '/activity/', '/recipes/pasta-tonno-pomodoro'])(
    'keeps Ricette current on its secondary route %s', (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <BottomNav />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: 'Ricette' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    },
  );

  it('keeps Chef current on the existing Cucina companion route', () => {
    render(
      <MemoryRouter initialEntries={['/cucina']}>
        <BottomNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Chef' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
  });

  it.each([
    '/pantry-notes',
    '/shopping-list-old',
    '/cucina-extra',
    '/plan-v2',
    '/recipes-archive',
    '/discover-more',
    '/saved-items',
    '/dinner-diary',
    '/dinner-diary-old',
  ])('does not mark a destination for a similar prefix: %s', (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <BottomNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(0);
  });

  it.each([
    '/discover/recipe',
    '/saved/recipe',
    '/dinner-diary/recipe',
    '/recipes/pasta-tonno-pomodoro/edit',
  ])('does not mark Ricette for an unmatched nested path: %s', (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <BottomNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(0);
  });
});