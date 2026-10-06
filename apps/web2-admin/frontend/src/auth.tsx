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
 * The shortest gap between two session checks. Focus and visibilitychange
 * often fire together, and an operator flicking between tabs should not cost
 * a request per flick.
 */
export const SESSION_CHECK_MIN_GAP_MS = 5_000;

/**
 * Set while someone is signed in in this browser, so a reload after the
 * session was revoked elsewhere can say the session ended rather than show a
 * blank login page. The cookie itself is httpOnly and cannot be read here.
 * Holds no token and nothing about the user, only that a session existed.
 */
const SIGNED_IN_MARK = 'web2-admin.signedIn';

/** Where one tab tells the others in the same browser that the session ended. */
export const SESSION_CHANNEL = 'web2-admin.session';

function markSignedIn(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(SIGNED_IN_MARK, '1');
    else localStorage.removeItem(SIGNED_IN_MARK);
  } catch {
    /* storage blocked: the login page just says less after a reload */
  }
}

function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_MARK) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether anyone is signed in, which decides what the whole console renders.
 *
 * It asks on boot, and again whenever the operator comes back to the tab
 * (window focus, or the page becoming visible), at most once every few
 * seconds. Any 401 from anywhere in the console, that check included, calls
 * back into here through http.ts, because a session can be revoked or expire
 * while the tab sits idle or between two clicks, and the screen must not go on
 * showing a shell whose every request is being refused. There is no timer:
 * every gated request refreshes the session's idle clock, so polling would
 * keep an unattended console signed in past its idle limit.
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
      return;
    }
    setUser(null);
    if (probe.reason === 'unreachable') {
      // Says nothing about the session, so the mark stays for the next try.
      setReason('unreachable');
      return;
    }
    // A 401 to a browser that was signed in a moment ago is a session that
    // ended (revoked elsewhere, or idle too long), not one that never was.
    setReason(probe.reason === 'notSignedIn' && wasSignedIn() ? 'ended' : probe.reason);
    markSignedIn(false);
  }, []);

  useEffect(() => {
    if (user) markSignedIn(true);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    // probeSession answers unreachable rather than rejecting.
    void api
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

  // The other tabs of this browser share the cookie, so when this one learns
  // the session is over it tells them, and each asks the server for itself
  // rather than taking the message's word for it.
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel !== 'function') return undefined;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = () => {
      if (userRef.current) api.checkSession().catch(() => undefined);
    };
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, []);

  // Any 401 from any endpoint means the session is gone. Dropping the user
  // here is enough: the route guard sees a null user and redirects to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only a session that was working counts as ended; a 401 with nobody
      // logged in is just the guard doing its job, and saying "your session
      // ended" to someone who never had one is a lie.
      if (userRef.current) {
        setReason('ended');
        channelRef.current?.postMessage('ended');
      }
      setUser(null);
      markSignedIn(false);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Ask again when the operator comes back to the tab, so a session revoked
  // from another browser shows up as the login page then rather than on the
  // next click. A 401 goes through the handler above; any other failure says
  // nothing about the session and is left for the next request to report.
  const signedIn = user !== null;
  const lastCheckRef = useRef(0);
  useEffect(() => {
    if (!signedIn) return undefined;

    const check = () => {
      const now = Date.now();
      if (now - lastCheckRef.current < SESSION_CHECK_MIN_GAP_MS) return;
      lastCheckRef.current = now;
      api.checkSession().catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };

    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [signedIn]);

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
    markSignedIn(false);
    channelRef.current?.postMessage('signedOut');
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
