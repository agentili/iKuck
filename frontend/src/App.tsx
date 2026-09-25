import { useEffect, useRef } from 'react';
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
import PantryPage from './pages/PantryPage';
import NotFoundPage from './pages/NotFoundPage';
import PantryMergeNotice from './components/feedback/PantryMergeNotice';
import { apiRequest } from './api/apiClient';
import { initializeSessionScope, listenForReconnect, syncVerifiedSession, type SyncSession } from './sync/syncQueue';
import { setActiveDataScope } from './sync/scopeContext';
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

export default function App() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const houseId = useHouseStore((state) => state.state?.house?.id ?? null);
  const pantryMergeSummary = usePantryMergeNoticeStore((state) => state.summary);
  const previousSessionKey = useRef<string | null>(null);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  useEffect(() => {
    const session = readVerifiedSession();
    const sessionKey = session === null ? 'guest' : `${session.userId}:${session.csrfToken}`;
    const sessionChanged = previousSessionKey.current !== sessionKey;
    previousSessionKey.current = sessionKey;
    let active = true;
    let removeReconnectListener: (() => void) | null = null;

    const hydrateAndSync = async (): Promise<void> => {
      await hydratePantryStore();
      if (!active) return;
      await Promise.all([
        hydrateShoppingListStore(),
        hydrateActivityStore(),
        hydrateDietProfileStore(),
      ]);
      if (!active || session === null) return;
      void syncVerifiedSession(session, {
        isSessionCurrent: () => {
          const current = readVerifiedSession();
          return current?.userId === session.userId && current.csrfToken === session.csrfToken;
        },
        onMembershipLost: () => {
          if (active) useHouseStore.getState().clear();
        },
      });
      removeReconnectListener = listenForReconnect(readVerifiedSession);
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
        .then(({ state, mergeSummary }) => {
          if (!active) return;
          useHouseStore.setState({ state });
          if (mergeSummary !== null && (mergeSummary.addedLots > 0 || mergeSummary.mergedLots > 0 || mergeSummary.importedStaples > 0)) {
            usePantryMergeNoticeStore.getState().show(mergeSummary);
          }
          return hydrateAndSync();
        })
        .catch(() => {
          if (active) void hydrateAndSync();
        });
    }

    return () => {
      active = false;
      removeReconnectListener?.();
    };
  }, [csrfToken, houseId, user]);

  return (
    <BrowserRouter>
      <div className="app-shell min-h-screen">
        <AppHeader />
        {pantryMergeSummary !== null && (
          <PantryMergeNotice
            summary={pantryMergeSummary}
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
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<NotFoundPage resource="page" />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
