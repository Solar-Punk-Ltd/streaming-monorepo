import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { User } from '@streaming-monorepo/web2-admin-common';

import * as api from './api';
import type { SessionProbe, SignedOutReason, SignInResult } from './api';
import { SessionEndedError, setUnauthorizedHandler } from './http';

export interface AuthState {
  /** null while the session probe is still running, and while signed out. */
  user: User | null;
  loading: boolean;
  /**
   * Why nobody is signed in. Only meaningful while `user` is null; the login
   * page keys its notice off it, and "ended" is the one that means a session
   * that was working a moment ago has gone.
   */
  reason: SignedOutReason;
  logIn: (username: string, password: string) => Promise<SignInResult>;
  logOut: () => Promise<void>;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Whether anyone is signed in, which decides what the whole console renders.
 *
 * It asks once on boot and then trusts itself, with one exception: any 401
 * from anywhere in the console calls back into here through http.ts, because a
 * session can be revoked or expire between two clicks and the screen must not
 * go on showing a shell whose every request is being refused.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState<SignedOutReason>('notSignedIn');

  // Read by the 401 handler, which is registered once and must not close over
  // a stale user.
  const userRef = useRef<User | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const apply = useCallback((probe: SessionProbe) => {
    if (probe.signedIn) {
      setUser(probe.user);
      setReason('notSignedIn');
    } else {
      setUser(null);
      setReason(probe.reason);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .probeSession()
      .then((probe) => {
        if (!cancelled) apply(probe);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // Any 401 from any endpoint means the session is gone. Dropping the user
  // here is enough: the route guard sees a null user and redirects to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only a session that was working counts as ended; a 401 with nobody
      // logged in is just the guard doing its job, and saying "your session
      // ended" to someone who never had one is a lie.
      if (userRef.current) setReason('ended');
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logIn = useCallback(async (username: string, password: string): Promise<SignInResult> => {
    const result = await api.signIn(username, password);
    if (result.ok) {
      setUser(result.user);
      setReason('notSignedIn');
    }
    return result;
  }, []);

  const logOut = useCallback(async () => {
    try {
      await api.logout();
    } catch (caught) {
      // A session that had already gone is a sign-out that has already
      // happened. Anything else leaves the session standing on the server, so
      // the caller is told rather than shown a login page that lies.
      if (!(caught instanceof SessionEndedError)) throw caught;
      // The fetch wrapper has already set the reason to "ended", which is the
      // one the login page has something to say about. Falling through would
      // overwrite it with the blank one.
      return;
    }
    setUser(null);
    setReason('notSignedIn');
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, reason, logIn, logOut, setUser }),
    [user, loading, reason, logIn, logOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
