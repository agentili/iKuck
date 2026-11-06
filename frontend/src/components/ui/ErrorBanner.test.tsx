import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ErrorBanner from './ErrorBanner';

describe('ErrorBanner', () => {
  it('rende il messaggio dentro un banner con role=alert', () => {
    render(<ErrorBanner message="Servizio non raggiungibile: riprova più tardi." />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Servizio non raggiungibile: riprova più tardi.');
    expect(banner).toHaveClass('border-[var(--ik-tomato)]', 'bg-[var(--ik-tomato-soft)]', 'text-[var(--ik-tomato)]');
  });
});
