import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GoogleSignInButton from './GoogleSignInButton';

describe('GoogleSignInButton', () => {
  it('explains when Google access is unavailable instead of exposing a failing action', () => {
    render(<GoogleSignInButton onCredential={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Accedi con Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Accesso con Google non disponibile in questo ambiente.')).toBeVisible();
  });
});
