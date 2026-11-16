import { useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { apiRequest } from '../../src/api/apiClient';
import { useAuthStore, type AuthState } from '../../src/auth/authStore';
import AiConsentSettings from '../../src/components/ai/AiConsentSettings';
import ProfilePage from '../../src/pages/ProfilePage';
import {
  getActiveDataScope,
  setActiveDataScope,
  setPersonalDataScope,
} from '../../src/sync/scopeContext';
import { initializeSessionScope, type SyncSession } from '../../src/sync/syncQueue';

interface ConsentRaceSnapshot {
  userId: string | null;
  csrfToken: string | null;
  scope: string;
  scopeError: string | null;
  profileMounts: number;
  profileUnmounts: number;
  consentMounts: number;
  consentUnmounts: number;
}

interface ConsentRaceDiagnostics extends ConsentRaceSnapshot {
  ready: boolean;
  snapshot: () => ConsentRaceSnapshot;
}

declare global {
  interface Window {
    __ikuckConsentRace?: ConsentRaceDiagnostics;
  }
}

const diagnosticState: ConsentRaceDiagnostics = {
  ready: false,
  userId: null,
  csrfToken: null,
  scope: getActiveDataScope(),
  scopeError: null,
  profileMounts: 0,
  profileUnmounts: 0,
  consentMounts: 0,
  consentUnmounts: 0,
  snapshot: () => {
    const { user, csrfToken } = useAuthStore.getState();
    return {
      userId: user?.id ?? null,
      csrfToken,
      scope: getActiveDataScope(),
      scopeError: diagnosticState.scopeError,
      profileMounts: diagnosticState.profileMounts,
      profileUnmounts: diagnosticState.profileUnmounts,
      consentMounts: diagnosticState.consentMounts,
      consentUnmounts: diagnosticState.consentUnmounts,
    };
  },
};

window.__ikuckConsentRace = diagnosticState;

const sessionFor = (state: AuthState): SyncSession | null => {
  const { user, csrfToken } = state;
  if (user === null || csrfToken === null || user.emailVerifiedAt.trim().length === 0) return null;
  return { userId: user.id, emailVerifiedAt: user.emailVerifiedAt, csrfToken };
};

let transitionGeneration = 0;

const applySessionScope = async (state: AuthState, generation: number): Promise<void> => {
  const session = sessionFor(state);
  if (session === null) {
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
    diagnosticState.scopeError = null;
    return;
  }

  try {
    await initializeSessionScope(session, apiRequest, () => {
      const current = useAuthStore.getState();
      return generation === transitionGeneration
        && current.user?.id === session.userId
        && current.csrfToken === session.csrfToken;
    });
    if (generation === transitionGeneration) diagnosticState.scopeError = null;
  } catch (error) {
    if (generation === transitionGeneration) {
      diagnosticState.scopeError = error instanceof Error ? error.message : String(error);
    }
    throw error;
  }
};

export const MountProbe = ({ kind, children }: { kind: 'profile' | 'consent'; children: ReactNode }) => {
  useEffect(() => {
    const mounts = kind === 'profile' ? 'profileMounts' : 'consentMounts';
    diagnosticState[mounts] += 1;
    return () => {
      const unmounts = kind === 'profile' ? 'profileUnmounts' : 'consentUnmounts';
      diagnosticState[unmounts] += 1;
    };
  }, [kind]);

  return children;
};

const start = async (): Promise<void> => {
  await useAuthStore.getState().restoreSession();
  const initialState = useAuthStore.getState();
  transitionGeneration += 1;
  await applySessionScope(initialState, transitionGeneration);

  useAuthStore.subscribe((state, previous) => {
    if (state.user?.id === previous.user?.id && state.csrfToken === previous.csrfToken) return;
    transitionGeneration += 1;
    void applySessionScope(state, transitionGeneration).catch(() => undefined);
  });

  const rootElement = document.getElementById('root');
  if (rootElement === null) throw new Error('The test harness root element is missing');
  createRoot(rootElement).render(
    <MemoryRouter initialEntries={['/profile']}>
      <div id="profile-race-root">
        <style>{'#profile-race-root > [data-testid="profile-page"] main#main-content #ai-consent-settings { display: none !important; }'}</style>
        <div data-testid="profile-page">
          <MountProbe kind="profile"><ProfilePage /></MountProbe>
        </div>
        <div data-testid="consent-race-settings">
          <MountProbe kind="consent"><AiConsentSettings /></MountProbe>
        </div>
      </div>
    </MemoryRouter>,
  );
  diagnosticState.ready = true;
};

void start().catch((error: unknown) => {
  diagnosticState.scopeError = error instanceof Error ? error.message : String(error);
  diagnosticState.ready = true;
});
