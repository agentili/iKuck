import { create } from 'zustand';
import { AuthState, User, ApiResponse } from '../types';
import * as api from '../utils/apiClient';

interface AuthStore extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, username: string) => Promise<void>;
  logout: () => void;
  initAuth: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,

  login: async (email, password) => {
    const res = await api.post<ApiResponse<{ userId: string; email: string; username: string; token: string }>>(
      '/auth/login',
      { email, password }
    );
    if (res.success && res.data) {
      localStorage.setItem('meal_planner_token', res.data.token);
      localStorage.setItem('meal_planner_user', JSON.stringify(res.data));
      set({
        user: { id: res.data.userId, email: res.data.email, username: res.data.username },
        token: res.data.token,
        isAuthenticated: true,
      });
    }
  },

  register: async (email, password, username) => {
    const res = await api.post<ApiResponse<{ userId: string; email: string; username: string; token: string }>>(
      '/auth/register',
      { email, password, username }
    );
    if (res.success && res.data) {
      localStorage.setItem('meal_planner_token', res.data.token);
      localStorage.setItem('meal_planner_user', JSON.stringify(res.data));
      set({
        user: { id: res.data.userId, email: res.data.email, username: res.data.username },
        token: res.data.token,
        isAuthenticated: true,
      });
    }
  },

  logout: () => {
    localStorage.removeItem('meal_planner_token');
    localStorage.removeItem('meal_planner_user');
    set({ user: null, token: null, isAuthenticated: false });
  },

  initAuth: () => {
    const token = localStorage.getItem('meal_planner_token');
    const userStr = localStorage.getItem('meal_planner_user');
    if (token && userStr) {
      const userData = JSON.parse(userStr);
      set({
        user: { id: userData.userId || userData.id, email: userData.email, username: userData.username },
        token,
        isAuthenticated: true,
      });
    }
  },
}));
