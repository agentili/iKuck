import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ProtectedRoute from './components/shared/ProtectedRoute';

const queryClient = new QueryClient();

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
            <Route path="/suggest" element={<div className="p-4"><h1>Suggerimenti</h1><p>Work in progress...</p></div>} />
            <Route path="/pantry" element={<div className="p-4"><h1>Dispensa</h1><p>Work in progress...</p></div>} />
            <Route path="/history" element={<div className="p-4"><h1>Storico</h1><p>Work in progress...</p></div>} />
            <Route path="/" element={<Navigate to="/suggest" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/suggest" replace />} />
        </Routes>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
