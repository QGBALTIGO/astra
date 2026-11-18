/**
 * Auth Hook & Provider
 *
 * Manages UI password authentication state.
 * Provides login/logout/refreshStatus and global 401 handling.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { authApi } from '../api/endpoints/auth';
import { apiClient } from '../api/client';
import { dispatchSessionChanged, onSessionChanged } from '../utils/session-events';

interface AuthState {
  isAuthenticated: boolean;
  passwordConfigured: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isTemporaryAuthError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error.status === 503 || error.status === 429)
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    passwordConfigured: false,
    isLoading: true,
  });
  const mounted = useRef(true);
  const statusRequestId = useRef(0);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStatusRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const refreshStatus = useCallback(
    async function refresh() {
      if (!mounted.current) return;
      clearStatusRetry();
      const requestId = ++statusRequestId.current;
      try {
        const status = await authApi.status();
        if (!mounted.current || requestId !== statusRequestId.current) return;
        retryAttempt.current = 0;

        if (!status.passwordConfigured) {
          // No password configured — everyone is authenticated
          setState({
            isAuthenticated: true,
            passwordConfigured: false,
            isLoading: false,
          });
        } else {
          // Password configured — use server's authentication check
          setState({
            isAuthenticated: status.authenticated,
            passwordConfigured: true,
            isLoading: false,
          });
        }
      } catch (error) {
        if (!mounted.current || requestId !== statusRequestId.current) return;
        if (isTemporaryAuthError(error)) {
          // Busy is not an invalid credential. Keep an already confirmed session;
          // on first load the existing loading screen still prevents access.
          setState((previous) =>
            previous.isLoading ? { ...previous, passwordConfigured: true } : previous
          );
          const delay = Math.min(30_000, 1000 * 2 ** retryAttempt.current);
          retryAttempt.current = Math.min(5, retryAttempt.current + 1);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void refresh();
          }, delay);
          return;
        }
        retryAttempt.current = 0;
        // Cookie-backed sessions are HttpOnly, so the server status endpoint is
        // the source of truth. Fail closed when we cannot reach it: treat the
        // app as "password configured, not authenticated" so AuthGuard sends
        // the user to /login instead of letting the full Layout flash with
        // optimistic state (cached chat list, sidebar pins, etc) before the
        // first pageload API call eventually returns 401.
        setState({
          isAuthenticated: false,
          passwordConfigured: true,
          isLoading: false,
        });
      }
    },
    [clearStatusRetry]
  );

  const login = useCallback(
    async (password: string) => {
      clearStatusRetry();
      statusRequestId.current++;
      await authApi.login(password);
      retryAttempt.current = 0;
      setState((prev) => ({ ...prev, isAuthenticated: true }));
      dispatchSessionChanged(true);
    },
    [clearStatusRetry]
  );

  const logout = useCallback(async () => {
    clearStatusRetry();
    statusRequestId.current++;
    try {
      await authApi.logout();
    } catch {
      // Ignore logout errors (token might already be invalid)
    }
    setState((prev) => ({ ...prev, isAuthenticated: false }));
    dispatchSessionChanged(false);
  }, [clearStatusRetry]);

  // Set up global 401 handler on mount.
  // When the server returns 401 (session expired / server restart),
  // mark the cookie-backed session invalid and force re-authentication.
  useEffect(() => {
    return apiClient.addOnError((error) => {
      if (error.status === 401) {
        clearStatusRetry();
        statusRequestId.current++;
        dispatchSessionChanged(false);
        setState((prev) => {
          if (!prev.isAuthenticated) return prev;
          // No password configured → the app is open; a stray 401 from any
          // endpoint must not eject the owner to a login screen they cannot
          // satisfy. Only force re-auth when a password actually gates the UI.
          if (!prev.passwordConfigured) return prev;
          return { ...prev, isAuthenticated: false };
        });
      }
    });
  }, [clearStatusRetry]);

  // Listen for session invalidation from raw fetch 401 handlers.
  useEffect(() => {
    return onSessionChanged((detail) => {
      if (!detail.authenticated) {
        clearStatusRetry();
        statusRequestId.current++;
        setState((prev) => {
          if (!prev.isAuthenticated) return prev;
          // No password configured → the app is open; a stray 401 from any
          // endpoint must not eject the owner to a login screen they cannot
          // satisfy. Only force re-auth when a password actually gates the UI.
          if (!prev.passwordConfigured) return prev;
          return { ...prev, isAuthenticated: false };
        });
      }
    });
  }, [clearStatusRetry]);

  // Fetch status on mount
  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    return () => {
      mounted.current = false;
      statusRequestId.current++;
      clearStatusRetry();
    };
  }, [refreshStatus, clearStatusRetry]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, refreshStatus }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
