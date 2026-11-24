import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { hasPermission } from '@pdv/shared';
import type { Permission, UserDTO } from '@pdv/shared';
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from '@/lib/api';
import {
  clearSession,
  grantIsValid,
  loadGrant,
  loadSession,
  saveSession,
} from '@/lib/offline/store';

interface AuthState {
  user: UserDTO | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState<boolean>(() => getToken() !== null);
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    setToken(null);
    void clearSession().catch(() => undefined); // filas pendentes permanecem no aparelho
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api<{ user: UserDTO }>('/auth/me')
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        void saveSession(res.user).catch(() => undefined);
      })
      .catch(async (err) => {
        // Sem rede: retoma a sessão só se houver autorização offline assinada e ainda válida.
        // Credencial inválida já aciona logout.
        if (err instanceof ApiError && err.isNetwork) {
          try {
            const [session, grant] = await Promise.all([loadSession(), loadGrant()]);
            if (!cancelled && session && grantIsValid(grant, session.user.id)) {
              setUser(session.user);
            }
          } catch {
            /* IndexedDB indisponível: segue sem sessão */
          }
        } else setToken(null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ token: string; user: UserDTO }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setToken(res.token);
    setUser(res.user);
    void saveSession(res.user).catch(() => undefined);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      logout,
      can: (permission) => (user ? hasPermission(user.role, permission) : false),
    }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
