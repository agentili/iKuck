import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './auth/authStore';
import HomePage from './pages/HomePage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import ProfilePage from './pages/ProfilePage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ShoppingListPage from './pages/ShoppingListPage';
import ActivityPage from './pages/ActivityPage';
import { listenForReconnect, syncVerifiedSession, type SyncSession } from './sync/syncQueue';
import { hydrateShoppingListStore } from './store/shoppingListStore';
import { hydrateActivityStore } from './store/activityStore';
import { hydrateDietProfileStore } from './store/dietProfileStore';

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

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  useEffect(() => {
    void hydrateShoppingListStore();
    void hydrateActivityStore();
    void hydrateDietProfileStore();
  }, []);

  useEffect(() => {
    const session = readVerifiedSession();
    if (session === null) return undefined;

    void syncVerifiedSession(session, {
      isSessionCurrent: () => {
        const current = readVerifiedSession();
        return current?.userId === session.userId && current.csrfToken === session.csrfToken;
      },
    });

    return listenForReconnect(readVerifiedSession);
  }, [csrfToken, user]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/shopping-list" element={<ShoppingListPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
