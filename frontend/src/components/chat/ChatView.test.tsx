import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';

vi.mock('./DailyRecipeCard', () => ({ DailyRecipeCard: () => <div>Proposta reale</div> }));
vi.mock('../../ai/chefChatStore', () => ({
  useChefChatStore: vi.fn((selector) => {
    const state = {
      messages: [],
      isSending: false,
      error: null,
      consentStatus: {
        consent: { enabled: true, updatedAt: new Date().toISOString(), chatProvider: 'openai' as const, chatPolicyVersion: 'chef-chat-v1' as const },
        selectedProvider: 'openai' as const,
      },
      isConsentLoaded: true,
      hasHydrated: true,
      currentScope: 'guest',
      sendMessage: vi.fn(),
      hydrate: vi.fn(),
      loadConsentStatus: vi.fn(),
      loadMessages: vi.fn(),
      setError: vi.fn(),
      clearError: vi.fn(),
    };
    return selector(state);
  }),
}));
vi.mock('../../auth/authStore', () => ({
  useAuthStore: vi.fn((selector) => {
    const state = {
      user: { id: 'user-1', email: 'test@example.com', emailVerifiedAt: new Date().toISOString() },
      csrfToken: 'test-csrf-token',
      connection: 'online' as const,
    };
    return selector(state);
  }),
}));

describe('Chef', () => {
  it('presents real chat interface above navigation', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<MemoryRouter><ChatView /></MemoryRouter>);

    // Should show the Chef header
    await waitFor(() => expect(screen.getByText('Chef')).toBeInTheDocument());

    // Should show welcome message when no messages
    await waitFor(() => expect(screen.getByText(/Ciao! Sono Chef/i)).toBeInTheDocument());

    // Should NOT show simulated content
    expect(screen.queryByText(/chat non disponibile/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/spaghetti al pomodoro/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /autorizza e genera/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /input vocale/i })).not.toBeInTheDocument();

    // Should have input bar for real chat
    expect(screen.getByPlaceholderText(/Chiedimi una ricetta/i)).toBeInTheDocument();
  });
});