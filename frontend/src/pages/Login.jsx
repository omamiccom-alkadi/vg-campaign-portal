import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import FullPageSpinner from '../components/FullPageSpinner';

export default function Login() {
  const { status, retryProfile } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // signInWithPassword resolving without an error is not the end of the flow:
  // status still has to clear the profiles gate. Release the form when it
  // settles on a non-authorized outcome, or the buttons stay disabled forever.
  useEffect(() => {
    if (status === 'unauthorized' || status === 'error') {
      setSubmitting(false);
    }
  }, [status]);

  if (status === 'loading') {
    return <FullPageSpinner label="Checking your access…" />;
  }

  if (status === 'authorized') {
    return <Navigate to="/dashboard" replace />;
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 px-4">
        <p className="max-w-sm text-center text-sm text-slate-700">
          Something went wrong loading your account. Try again.
        </p>
        <button
          type="button"
          onClick={() => {
            void retryProfile();
          }}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
      </div>
    );
  }

  // Not gated on router state alone: a direct sign-in on this page never gets
  // a ProtectedRoute redirect, so status is the primary signal.
  const unauthorized = status === 'unauthorized' || location.state?.reason === 'unauthorized';

  async function handlePasswordSignIn(event) {
    event.preventDefault();
    setFormError('');
    setSubmitting(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setFormError('Incorrect email or password.');
      setSubmitting(false);
    }
    // On success, onAuthStateChange drives status → loading → authorized
    // (or unauthorized). Do not navigate from here.
  }

  async function handleGoogleSignIn() {
    setFormError('');
    setSubmitting(true);

    // --- Google OAuth seam ---
    // redirectTo is the current origin's /dashboard so localhost and Vercel
    // both land in the same place. Site URL / Redirect URLs must include this
    // origin; they are configured in the hosted Supabase dashboard, not in this repo.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });

    if (error) {
      setFormError('Google sign-in failed. Please try again.');
      setSubmitting(false);
    }
    // On success the browser leaves this page; keep submitting=true.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-[400px] rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-xl font-semibold text-slate-900">
          Client Campaign Portal
        </h1>

        {unauthorized && (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            This account is not authorized for this portal.
          </p>
        )}

        {formError && (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {formError}
          </p>
        )}

        <form onSubmit={handlePasswordSignIn} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Sign in
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={submitting}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
