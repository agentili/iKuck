import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import SuggestionPage from './pages/SuggestionPage';
import PantryPage from './pages/PantryPage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import HistoryPage from './pages/HistoryPage';
import ProtectedRoute from './components/shared/ProtectedRoute';
import Header from './components/shared/Header';
import BottomNavigation from './components/shared/BottomNavigation';

const queryClient = new QueryClient();

const MainLayout = () => {
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1 overflow-y-auto bg-gray-50 pb-20">
        <Outlet />
      </main>
      <BottomNavigation />
    </div>
  );
};

function App() {
  const { initAuth } = useAuthStore();

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          
          <Route element={<ProtectedRoute />}>
            <Route element={<MainLayout />}>
              <Route path="/suggest" element={<SuggestionPage />} />
              <Route path="/pantry" element={<PantryPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/recipe/:recipeId" element={<RecipeDetailPage />} />
            </Route>
            <Route path="/" element={<Navigate to="/suggest" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/suggest" replace />} />
        </Routes>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
