import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from './auth/authStore';
import { useHouseStore } from './house/houseStore';
import AppHeader from './components/layout/AppHeader';
import { BottomNav } from './components/layout/BottomNav';
import { SimplifiedHeader } from './components/layout/SimplifiedHeader';
import HomePage from './pages/HomePage';
import ChatPage from './pages/ChatPage';
import DiscoverPage from './pages/DiscoverPage';
import SavedPage from './pages/SavedPage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import ProfilePage from './pages/ProfilePage';
import HousePage from './pages/HousePage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ShoppingListPage from './pages/ShoppingListPage';
import ActivityPage from './pages/ActivityPage';
import DinnerDiaryPage from './pages/DinnerDiaryPage';
import RecipesPage from './pages/RecipesPage';
import PantryPage from './pages/PantryPage';
import PlanPage from './pages/PlanPage';
import NotFoundPage from './pages/NotFoundPage';
import PantryMergeNotice from './components/feedback/PantryMergeNotice';
import { apiRequest } from './api/apiClient';
import { initializeSessionScope, listenForReconnect, syncVerifiedSession, type SyncSession } from './sync/syncQueue';
import { getActiveDataScope, setActiveDataScope, subscribeActiveDataScope } from './sync/scopeContext';
import { isScopePurgeMarkerUnavailable, isScopeWritable, subscribeScopeAvailability } from './sync/scopeWriteFence';
import { hydrateShoppingListStore } from './store/shoppingListStore';
import { hydrateActivityStore } from './store/activityStore';
import { hydrateDietProfileStore } from './store/dietProfileStore';
import { hydratePantryStore } from './store/localPantryStore';
import { usePantryMergeNoticeStore } from './store/pantryMergeNoticeStore';
import { isSousChef, isBottomNav, isSimplifiedHeader } from './config/features';

const readVerifiedSession = (): SyncSession | null => {
  const { user, csrfToken } = useAuthStore.getState();
  if (user === null || csrfToken === null || user.emailVerifiedAt === '') return null;

  return {
    userId: user.id,
    emailVerifiedAt: user.emailVerifiedAt,
    csrfToken,
  };
};

const subscribeVisibleScope = (listener: () => void): (() => void) => {
  const stopScope = subscribeActiveDataScope(listener);
  const stopAvailability = subscribeScopeAvailability(listener);
  return () => { stopScope(); stopAvailability(); };
};
const getVisibleScope = (): string => {
  const scope = getActiveDataScope();
  return isScopeWritable(scope) ? scope : `revoked:${scope}`;
};

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  const location = useLocation();
  useEffect(() => {
    if (!isSousChef()) return;

    const focusSkipLinkFirst = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.shiftKey || document.activeElement !== document.body) return;
      const skipLink = document.querySelector<HTMLAnchorElement>('.sous-chef-skip-link');
      if (skipLink === null) return;
      event.preventDefault();
      skipLink.focus();
    };

    document.addEventListener('keydown', focusSkipLinkFirst, true);
    return () => document.removeEventListener('keydown', focusSkipLinkFirst, true);
  }, []);

  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const houseId = useHouseStore((state) => state.state?.house?.id ?? null);
  const visibleScope = useSyncExternalStore(subscribeVisibleScope, getVisibleScope, getVisibleScope);
  const pantryMergeSummary = usePantryMergeNoticeStore((state) => state.summary);
  const pantryMergeFailed = usePantryMergeNoticeStore((state) => state.mergeFailed);
  const previousSessionKey = useRef<string | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [readySessionKey, setReadySessionKey] = useState<string | null>(null);
  const [scopeReadySessionKey, setScopeReadySessionKey] = useState<string | null>(null);
  const [scopeInitializationFailed, setScopeInitializationFailed] = useState(false);
  const [scopeRetryCount, setScopeRetryCount] = useState(0);
  const verifiedSession = user !== null && csrfToken !== null && user.emailVerifiedAt !== '';
  const currentSessionKey = verifiedSession ? `${user.id}:${csrfToken}` : 'guest';

  useEffect(() => {
    let active = true;
    void restoreSession().catch(() => undefined).finally(() => {
      if (active) setSessionRestored(true);
    });
    return () => { active = false; };
  }, [restoreSession]);

  useEffect(() => {
    if (!sessionRestored) return;
    const session = readVerifiedSession();
    const sessionKey = session === null ? 'guest' : `${session.userId}:${session.csrfToken}`;
    const sessionChanged = previousSessionKey.current !== sessionKey;
    previousSessionKey.current = sessionKey;
    setScopeInitializationFailed(false);
    setScopeReadySessionKey(null);
    let active = true;
    let removeReconnectListener: (() => void) | null = null;

    const hydrateAndSync = async (shouldSync = true): Promise<void> => {
      if (session !== null && !isScopeWritable(getActiveDataScope())) return;
      await hydratePantryStore();
      if (!active) return;
      await Promise.all([
        hydrateShoppingListStore(),
        hydrateActivityStore(),
        hydrateDietProfileStore(),
      ]);
      if (!active) return;
      setReadySessionKey(sessionKey);
      if (session === null || !shouldSync) return;
      void syncVerifiedSession(session, {
        isSessionCurrent: () => {
          const current = readVerifiedSession();
          return current?.userId === session.userId && current.csrfToken === session.csrfToken;
        },
        onMembershipLost: () => {
          if (active) useHouseStore.getState().clear();
        },
      });
      removeReconnectListener = listenForReconnect(readVerifiedSession, () => {
        if (active) useHouseStore.getState().clear();
      });
    };

    if (session === null) {
      if (sessionChanged) useHouseStore.getState().clear();
      setActiveDataScope('guest');
      setScopeReadySessionKey(sessionKey);
      void hydrateAndSync();
    } else {
      if (sessionChanged) useHouseStore.getState().clear();
      void initializeSessionScope(session, apiRequest, () => {
        if (!active) return false;
        const current = readVerifiedSession();
        return current?.userId === session.userId && current.csrfToken === session.csrfToken;
      })
        .then(({ state, mergeSummary, guestMergeFailed }) => {
          if (!active) return;
          useHouseStore.setState({ state });
          setScopeReadySessionKey(sessionKey);
          if (guestMergeFailed) {
            usePantryMergeNoticeStore.getState().showFailure();
          } else if (mergeSummary !== null && (mergeSummary.addedLots > 0 || mergeSummary.mergedLots > 0 || mergeSummary.importedStaples > 0)) {
            usePantryMergeNoticeStore.getState().show(mergeSummary);
          } else if (mergeSummary !== null && usePantryMergeNoticeStore.getState().mergeFailed) {
            usePantryMergeNoticeStore.getState().clear();
          } else if (
            usePantryMergeNoticeStore.getState().mergeFailed
            && (state === null || state.house === null || state.house === undefined)
          ) {
            usePantryMergeNoticeStore.getState().clear();
          }
          return hydrateAndSync();
        })
        .catch(() => {
          if (active) setScopeInitializationFailed(true);
        });
    }

    return () => {
      active = false;
      removeReconnectListener?.();
    };
  }, [csrfToken, houseId, scopeRetryCount, sessionRestored, user]);

  const expectedVisibleScope = verifiedSession
    ? (houseId === null ? `account:${user.id}` : `house:${houseId}`)
    : 'guest';
  const currentHouseScope: `house:${string}` | null = houseId !== null
    ? `house:${houseId}`
    : getActiveDataScope().startsWith('house:') ? getActiveDataScope() as `house:${string}` : null;
  const housePurgeMarkerUnavailable = verifiedSession
    && currentHouseScope !== null
    && isScopePurgeMarkerUnavailable(currentHouseScope);
  if (verifiedSession && (housePurgeMarkerUnavailable || scopeInitializationFailed)) {
    return (
      <div className="app-shell min-h-screen">
        <AppHeader scopeUnverified={scopeInitializationFailed} />
        <main id="main-content" className="mx-auto min-h-screen w-full max-w-2xl px-4 pb-24 pt-24 sm:px-6 sm:pt-28">
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950" role="alert">
            <p>
              {housePurgeMarkerUnavailable
                ? 'Non posso verificare la sicurezza dei dati della Casa perché la memoria locale del browser non è disponibile. Le scritture restano disabilitate; verifica la memoria locale e ricarica l’app.'
                : 'Non è stato possibile verificare l’ambito della Casa. Dispensa, spesa e diario restano nascosti e le scritture funzionali sono sospese finché il controllo non riesce. Verifica la connessione e riprova.'}
            </p>
            <button
              type="button"
              className="mt-4 min-h-11 rounded-xl bg-[var(--ik-basil-dark)] px-4 py-2 font-bold text-white hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-basil-dark)]"
              onClick={() => {
                if (housePurgeMarkerUnavailable) window.location.reload();
                else setScopeRetryCount((count) => count + 1);
              }}
            >
              {housePurgeMarkerUnavailable ? 'Ricarica l’app' : 'Riprova'}
            </button>
          </div>
        </main>
      </div>
    );
  }
  const sessionRecoveryRoute = location.pathname === '/'
    || location.pathname === '/profile'
    || location.pathname === '/pantry'
    || location.pathname === '/shopping-list';
  const scopeReadyForCurrentSession = sessionRecoveryRoute && scopeReadySessionKey === currentSessionKey;
  // Show recovery routes after scope verification; PantryPage keeps its own local-data hydration gate.
  if (!sessionRestored
    || (readySessionKey !== currentSessionKey && !scopeReadyForCurrentSession)
    || visibleScope !== expectedVisibleScope) {
    return <div className="app-shell min-h-screen" role="status">Caricamento dati…</div>;
  }

  // Feature flag: SOUS-CHEF UI
  if (isSousChef()) {
    return (
      <div className="sous-chef-shell min-h-screen bg-[var(--ik-porcelain)]">
          <a className="sous-chef-skip-link" href="#sous-chef-main-content">
            Vai al contenuto principale
          </a>
          {/* Simplified Header */}
          {isSimplifiedHeader() && <SimplifiedHeader />}

          {/* Main Content with padding for header and bottom nav */}
          <div
            className={`sous-chef-main min-h-screen ${
              isBottomNav() ? 'pb-20' : 'pb-8'
            } ${
              isSimplifiedHeader() ? 'pt-16' : 'pt-0'
            }`}
          >
            <div id="sous-chef-main-content" className="sous-chef-main-content" tabIndex={-1}>
              <Routes>
                {/* SOUS-CHEF Routes */}
                <Route path="/" element={<ChatPage />} />
                <Route path="/cucina" element={<HomePage />} />
                <Route path="/discover" element={<DiscoverPage />} />
                <Route path="/saved" element={<SavedPage />} />
                {/* Reuse the existing local/house Plan implementation. */}
                <Route path="/plan" element={<PlanPage />} />

                {/* Existing Routes (preserved) */}
                <Route path="/recipes" element={<RecipesPage />} />
                <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/house" element={<HousePage />} />
                <Route path="/pantry" element={<PantryPage />} />
                <Route path="/shopping-list" element={<ShoppingListPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/dinner-diary" element={<DinnerDiaryPage />} />
                <Route path="/verify-email" element={<VerifyEmailPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="*" element={<NotFoundPage resource="page" />} />
              </Routes>
            </div>
          </div>

          {/* Bottom Navigation */}
          {isBottomNav() && <BottomNav />}

          {/* Pantry Merge Notice */}
          {(pantryMergeSummary !== null || pantryMergeFailed) && (
            <PantryMergeNotice
              summary={pantryMergeSummary}
              guestMergeFailed={pantryMergeFailed}
              onDismiss={() => usePantryMergeNoticeStore.getState().clear()}
            />
          )}
        </div>
    );
  }

  // Legacy UI (original iKuck)
  return (
    <div className="app-shell min-h-screen">
        <AppHeader />
        {(pantryMergeSummary !== null || pantryMergeFailed) && (
          <PantryMergeNotice
            summary={pantryMergeSummary}
            guestMergeFailed={pantryMergeFailed}
            onDismiss={() => usePantryMergeNoticeStore.getState().clear()}
          />
        )}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/house" element={<HousePage />} />
          <Route path="/pantry" element={<PantryPage />} />
          <Route path="/shopping-list" element={<ShoppingListPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/dinner-diary" element={<DinnerDiaryPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<NotFoundPage resource="page" />} />
        </Routes>
    </div>
  );
}
