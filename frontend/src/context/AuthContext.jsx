import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

/**
 * status is the ONLY gate signal. There is no separate `loading` boolean.
 *
 *   loading         — initial session check, OR profile lookup in flight
 *   authorized      — session confirmed AND a profiles row exists for this user
 *   unauthenticated — no session
 *   unauthorized    — session existed, profiles returned zero rows; signOut() issued.
 *                     Survives the subsequent SIGNED_OUT event so Login can show
 *                     the "not authorized" message.
 *   error           — profiles query failed (network / 5xx). Not a rejection.
 *                     Do not sign out; ProtectedRoute shows a retry.
 *
 * `error` is a fifth value because collapsing a failed lookup into `loading`
 * would spin forever, and collapsing it into `unauthorized` would sign out
 * legitimate users on a blip. ProtectedRoute still treats it as "not safe
 * to render protected content."
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);

  const lastUserIdRef = useRef(null);
  const fetchGenRef = useRef(0);

  const resolveSession = useCallback(async (session) => {
    const sessionUser = session?.user ?? null;
    const userId = sessionUser?.id ?? null;

    if (!userId) {
      lastUserIdRef.current = null;
      setUser(null);
      setProfile(null);
      setError(null);
      // Preserve `unauthorized` through the signOut() that caused it, so Login
      // can distinguish "not authorized" from "has not signed in."
      setStatus((prev) => (prev === 'unauthorized' ? 'unauthorized' : 'unauthenticated'));
      return;
    }

    // TOKEN_REFRESHED (and duplicate INITIAL_SESSION) must not flip the app
    // back to `loading` or re-hit profiles. Only a *different* user id fetches.
    if (userId === lastUserIdRef.current) {
      setUser(sessionUser);
      return;
    }

    lastUserIdRef.current = userId;
    const gen = ++fetchGenRef.current;
    setUser(sessionUser);
    setProfile(null);
    setError(null);
    setStatus('loading');

    const { data, error: queryError } = await supabase
      .from('profiles')
      .select('id, role, brand_id, brands ( id, name, slug )')
      .eq('id', userId)
      .maybeSingle();

    // Arrival-order guard: a slower fetch for a previous user must not win.
    if (gen !== fetchGenRef.current || lastUserIdRef.current !== userId) {
      return;
    }

    if (queryError) {
      setProfile(null);
      setError('We could not verify your access. Please try again.');
      setStatus('error');
      return;
    }

    if (!data) {
      // HARD GATE. Flip status BEFORE awaiting signOut so no render can treat
      // "session exists, profile still loading" as authorized.
      setProfile(null);
      setError(null);
      setStatus('unauthorized');
      await supabase.auth.signOut();
      return;
    }

    setProfile({
      id: data.id,
      role: data.role,
      brand_id: data.brand_id,
      brand: data.brands ?? null,
    });
    setError(null);
    setStatus('authorized');
  }, []);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled) {
        void resolveSession(session);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Never await supabase from inside this callback — the client holds a
      // lock while it runs, and re-entering the client can deadlock. This must
      // be a macrotask (setTimeout 0), not queueMicrotask: microtasks can still
      // drain inside the lock-holding async chain.
      setTimeout(() => {
        if (!cancelled) {
          void resolveSession(session);
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [resolveSession]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const retryProfile = useCallback(async () => {
    lastUserIdRef.current = null;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    await resolveSession(session);
  }, [resolveSession]);

  const value = useMemo(
    () => ({ status, user, profile, error, signOut, retryProfile }),
    [status, user, profile, error, signOut, retryProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
