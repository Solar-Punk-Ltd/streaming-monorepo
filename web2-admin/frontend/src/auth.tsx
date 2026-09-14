import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@streaming-monorepo/web2-admin-common';

import * as api from './api';
import { setUnauthorizedHandler } from './http';

export interface AuthState {
  /** null while the session probe is still running. */
  user: User | null;
  loading: boolean;
  /** True when a 401 ended a session that was working a moment ago. */
  sessionExpired: boolean;
  logIn: (username: string, password: string) => Promise<void>;
  logOut: () => Promise<void>;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Read by the 401 handler, which is registered once and must not close over
  // a stale user.
  const userRef = useRef<User | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchMe()
      .then((me) => {
        if (!cancelled) setUser(me?.user ?? null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from any endpoint means the session is gone. Dropping the user
  // here is enough: the route guard sees a null user and redirects to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only a session that was working counts as expired; a 401 with nobody
      // logged in is just the guard doing its job.
      if (userRef.current) setSessionExpired(true);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logIn = useCallback(async (username: string, password: string) => {
    const me = await api.login({ username, password });
    setSessionExpired(false);
    setUser(me.user);
  }, []);

  const logOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, sessionExpired, logIn, logOut, setUser }),
    [user, loading, sessionExpired, logIn, logOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
