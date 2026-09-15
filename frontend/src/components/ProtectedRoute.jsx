import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import FullPageSpinner from './FullPageSpinner';

export default function ProtectedRoute({ children }) {
  const { status, error, retryProfile } = useAuth();
  const location = useLocation();

  // Covers BOTH the initial session check and the in-flight profile lookup.
  // Deliberately falls through to neither branch below.
  if (status === 'loading') {
    return <FullPageSpinner label="Checking your access…" />;
  }

  // Profile lookup failed — session may exist, but we have not proven
  // authorization. Never render protected content; never bounce to /login
  // (that would look like a silent logout on a network blip).
  if (status === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 px-4">
        <p className="max-w-sm text-center text-sm text-slate-700">
          {error || 'We could not verify your access. Please try again.'}
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

  if (status === 'unauthorized') {
    return <Navigate to="/login" replace state={{ reason: 'unauthorized' }} />;
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Affirmative check. Never `return children` as a bare fallthrough.
  return status === 'authorized' ? children : null;
}
