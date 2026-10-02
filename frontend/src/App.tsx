import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './auth/authStore';
import { useHouseStore } from './house/houseStore';
import AppHeader from './components/layout/AppHeader';
import HomePage from './pages/HomePage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import ProfilePage from './pages/ProfilePage';
import HousePage from './pages/HousePage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ShoppingListPage from './pages/ShoppingListPage';
import ActivityPage from './pages/ActivityPage';
import DinnerDiaryPage from './pages/DinnerDiaryPage';
import PantryPage from './pages/PantryPage';
import NotFoundPage from './pages/NotFoundPage';
import PantryMergeNotice from './components/feedback/PantryMergeNotice';
import { apiRequest } from './api/apiClient';
import { initializeSessionScope, listenForReconnect, syncVerifiedSession, type SyncSession } from './sync/syncQueue';
import { getActiveDataScope, setActiveDataScope, subscribeActiveDataScope } from './sync/scopeContext';
import { isScopeWritable, subscribeScopeAvailability } from './sync/scopeWriteFence';
import { hydrateShoppingListStore } from './store/shoppingListStore';
import { hydrateActivityStore } from './store/activityStore';
import { hydrateDietProfileStore } from './store/dietProfileStore';
import { hydratePantryStore } from './store/localPantryStore';
import { usePantryMergeNoticeStore } from './store/pantryMergeNoticeStore';

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
    let active = true;
    let removeReconnectListener: (() => void) | null = null;

    const hydrateAndSync = async (shouldSync = true): Promise<void> => {
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
          if (active) void hydrateAndSync(false);
        });
    }

    return () => {
      active = false;
      removeReconnectListener?.();
    };
  }, [csrfToken, houseId, sessionRestored, user]);

  const expectedVisibleScope = verifiedSession
    ? (houseId === null ? `account:${user.id}` : `house:${houseId}`)
    : 'guest';
  if (!sessionRestored || readySessionKey !== currentSessionKey || visibleScope !== expectedVisibleScope) {
    return <div className="app-shell min-h-screen" role="status">Caricamento dati…</div>;
  }

  return (
    <BrowserRouter>
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
          <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/house" element={<HousePage />} />
          <Route path="/pantry" element={<PantryPage />} />
          <Route path="/shopping-list" element={<ShoppingListPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/dinner-diary" element={<DinnerDiaryPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<NotFoundPage resource="page" />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
