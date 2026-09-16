import { Link } from 'react-router-dom';

// Stand-in for the navigation bar we deferred. Kept as one component so the
// five pages using it stay consistent, and so that nav bar has a single place
// to replace rather than five.
export default function BackToDashboard() {
  return (
    <Link
      to="/dashboard"
      className="mb-3 inline-block text-sm text-slate-600 hover:text-slate-900 hover:underline"
    >
      &larr; Back to Dashboard
    </Link>
  );
}
