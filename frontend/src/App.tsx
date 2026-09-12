import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './auth/authStore';
import HomePage from './pages/HomePage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import ProfilePage from './pages/ProfilePage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import { syncOnReconnect, type SyncSession } from './sync/syncQueue';

export default function App() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const restoreSession = useAuthStore((state) => state.restoreSession);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  useEffect(() => {
    if (user === null || csrfToken === null || user.emailVerifiedAt === '') return undefined;

    const session: SyncSession = {
      userId: user.id,
      emailVerifiedAt: user.emailVerifiedAt,
      csrfToken,
    };
    return syncOnReconnect(() => session);
  }, [csrfToken, user]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
