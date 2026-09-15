import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { profile, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Client Campaign Portal</p>
            <p className="text-xs text-slate-500">
              {profile?.brand?.name ?? 'Unknown brand'} · {profile?.role}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-sm text-slate-600">Dashboard placeholder.</p>
      </main>
    </div>
  );
}
