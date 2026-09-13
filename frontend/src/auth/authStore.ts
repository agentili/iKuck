import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { AccountSummary } from '@ikuck/shared/contracts';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';

export type ConnectionState = 'unknown' | 'online' | 'offline';

export interface AuthUser extends AccountSummary {}

export interface AuthState {
  user: AuthUser | null;
  csrfToken: string | null;
  expiresAt: string | null;
  connection: ConnectionState;
  isLoading: boolean;
  restoreSession: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  linkGoogle: (credential: string) => Promise<void>;
  register: (email: string, password: string) => Promise<{ verificationRequired: boolean }>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (token: string, password: string) => Promise<void>;
  clearSession: () => void;
}

interface SessionResponse {
  authenticated: boolean;
  user?: AuthUser;
  csrfToken?: string;
  expiresAt?: string;
}

interface RegistrationResponse {
  verificationRequired: boolean;
}

export interface AuthStoreOptions {
  request?: ApiRequest;
}

type AuthStore = UseBoundStore<StoreApi<AuthState>>;

const isVerifiedUser = (user: AuthUser | undefined): user is AuthUser => (
  user !== undefined && user.emailVerifiedAt.trim().length > 0
);

const assertAuthenticatedResponse = (response: SessionResponse | undefined): { user: AuthUser; csrfToken: string; expiresAt: string } => {
  if (response === undefined || !response.authenticated || !isVerifiedUser(response.user) || !response.csrfToken || !response.expiresAt) {
    throw new ApiClientError(403, 'email_not_verified', 'Email verification is required');
  }

  return {
    user: response.user,
    csrfToken: response.csrfToken,
    expiresAt: response.expiresAt,
  };
};

const isNetworkError = (error: unknown): boolean => (
  typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'network_error'
);

export const createAuthStore = (options: AuthStoreOptions | ApiRequest = {}): AuthStore => {
  const request = typeof options === 'function' ? options : options.request ?? apiRequest;

  return create<AuthState>((set, get) => {
    const clearSession = () => set({ user: null, csrfToken: null, expiresAt: null });

    const run = async (operation: () => Promise<void>): Promise<void> => {
      set({ isLoading: true });
      try {
        await operation();
        set({ connection: 'online' });
      } catch (error) {
        if (isNetworkError(error)) set({ connection: 'offline' });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    };

    return {
      user: null,
      csrfToken: null,
      expiresAt: null,
      connection: 'unknown',
      isLoading: false,
      restoreSession: async () => {
        try {
          await run(async () => {
            const response = await request<SessionResponse>('/v1/auth/session');
            if (response === undefined || !response.authenticated) {
              clearSession();
              return;
            }

            const session = assertAuthenticatedResponse(response);
            set(session);
          });
        } catch (error) {
          if (!isNetworkError(error)) throw error;
        }
      },
      login: async (email, password) => {
        await run(async () => {
          const response = await request<SessionResponse>('/v1/auth/login', {
            method: 'POST',
            body: { email, password },
          });
          set(assertAuthenticatedResponse(response));
        });
      },
      loginWithGoogle: async (credential) => {
        await run(async () => {
          const response = await request<SessionResponse>('/v1/auth/google', {
            method: 'POST',
            body: { credential },
          });
          set(assertAuthenticatedResponse(response));
        });
      },
      linkGoogle: async (credential) => {
        const csrfToken = get().csrfToken;
        if (csrfToken === null) throw new ApiClientError(401, 'session_required', 'Authentication is required');
        await run(async () => {
          await request('/v1/auth/google/link', {
            method: 'POST',
            body: { credential },
            csrfToken,
          });
        });
      },
      register: async (email, password) => {
        let result: RegistrationResponse | undefined;
        await run(async () => {
          result = await request<RegistrationResponse>('/v1/auth/register', {
            method: 'POST',
            body: { email, password },
          });
        });
        return result ?? { verificationRequired: true };
      },
      resendVerification: async (email) => {
        await run(async () => {
          await request('/v1/auth/resend-verification', {
            method: 'POST',
            body: { email },
          });
        });
      },
      logout: async () => {
        const csrfToken = get().csrfToken;
        if (get().user === null || csrfToken === null) {
          clearSession();
          return;
        }

        await run(async () => {
          try {
            await request('/v1/auth/logout', { method: 'POST', csrfToken });
          } finally {
            clearSession();
          }
        });
      },
      requestPasswordReset: async (email) => {
        await run(async () => {
          await request('/v1/auth/request-password-reset', {
            method: 'POST',
            body: { email },
          });
        });
      },
      resetPassword: async (token, password) => {
        await run(async () => {
          await request('/v1/auth/reset-password', {
            method: 'POST',
            body: { token, password },
          });
          clearSession();
        });
      },
      clearSession,
    };
  });
};

export const useAuthStore = createAuthStore();
