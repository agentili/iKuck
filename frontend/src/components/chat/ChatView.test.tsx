import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';

const { chatState, authState } = vi.hoisted(() => ({
  chatState: {
    messages: [] as Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: Date; isOptimistic?: boolean }>,
    isSending: false,
    error: null as string | null,
    consentStatus: null as null | {
      consent: { enabled: boolean; updatedAt: string; chatProvider?: 'openai' | 'gemini'; chatPolicyVersion?: 'chef-chat-v1' };
      selectedProvider: 'openai' | 'gemini';
    },
    isConsentLoaded: false,
    hasHydrated: false,
    sendMessage: vi.fn(),
    hydrate: vi.fn(),
    loadConsentStatus: vi.fn(),
    clearError: vi.fn(),
  },
  authState: {
    user: null as null | { id: string; email: string; emailVerifiedAt: string },
    csrfToken: null as string | null,
    connection: 'online' as 'online' | 'offline' | 'unknown',
  },
}));

vi.mock('./DailyRecipeCard', () => ({ DailyRecipeCard: () => <div>Proposta locale</div> }));
vi.mock('../../ai/chefChatStore', () => ({
  useChefChatStore: vi.fn((selector) => selector(chatState)),
}));
vi.mock('../../auth/authStore', () => ({
  useAuthStore: vi.fn((selector) => selector(authState)),
}));

const consentGranted = {
  consent: {
    enabled: true,
    updatedAt: '2026-10-01T08:00:00.000Z',
    chatProvider: 'openai' as const,
    chatPolicyVersion: 'chef-chat-v1' as const,
  },
  selectedProvider: 'openai' as const,
};

const renderChef = () => render(<MemoryRouter><ChatView /></MemoryRouter>);

const quickNavigationDestinations = [
  { label: 'Ricette', path: '/recipes' },
  { label: 'Dispensa', path: '/pantry' },
  { label: 'Spesa', path: '/shopping-list' },
  { label: 'Casa', path: '/house' },
  { label: 'Cucina viva', path: '/cucina' },
] as const;

const expectQuickNavigationGroup = () => {
  const group = screen.getByRole('group', { name: 'Risposte rapide' });
  const links = within(group).getAllByRole('link');
  expect(links).toHaveLength(quickNavigationDestinations.length);

  for (const destination of quickNavigationDestinations) {
    expect(within(group).getByRole('link', { name: destination.label }))
      .toHaveAttribute('href', destination.path);
  }
};

describe('Chef landing page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatState.messages = [];
    chatState.isSending = false;
    chatState.error = null;
    chatState.consentStatus = consentGranted;
    chatState.isConsentLoaded = true;
    chatState.hasHydrated = true;
    authState.user = { id: 'user-1', email: 'test@example.com', emailVerifiedAt: '2026-10-01T08:00:00.000Z' };
    authState.csrfToken = 'test-csrf-token';
    authState.connection = 'online';
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('makes the deferred AI chat explicit and retains local content and real destinations', () => {
    renderChef();

    expect(screen.getByRole('heading', { name: 'Chef' })).toBeVisible();
    expect(screen.getByText('Chat AI non disponibile. La chat AI è stata rinviata.', { exact: true })).toBeVisible();
    expect(screen.getByText('Proposta locale')).toBeVisible();
    expectQuickNavigationGroup();
    expect(screen.queryByRole('textbox', { name: 'Messaggio per Chef' })).not.toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invia messaggio' })).not.toBeInTheDocument();
    expect(chatState.hydrate).not.toHaveBeenCalled();
    expect(chatState.loadConsentStatus).not.toHaveBeenCalled();
    expect(chatState.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the deferral notice and navigation available to a guest while offline', () => {
    authState.user = null;
    authState.csrfToken = null;
    authState.connection = 'offline';
    chatState.consentStatus = null;
    chatState.isConsentLoaded = false;
    chatState.hasHydrated = false;
    renderChef();

    expect(screen.getByText('Chat AI non disponibile. La chat AI è stata rinviata.', { exact: true })).toBeVisible();
    expectQuickNavigationGroup();
    expect(screen.queryByRole('textbox', { name: 'Messaggio per Chef' })).not.toBeInTheDocument();
    expect(chatState.loadConsentStatus).not.toHaveBeenCalled();
  });
});
