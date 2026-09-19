import { UserRound } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../auth/authStore';

const primaryLinks = [
  { path: '/', label: 'Home' },
  { path: '/shopping-list', label: 'Lista' },
  { path: '/activity', label: 'Attività' },
  { path: '/profile', label: 'Profilo' },
] as const;

export default function AppHeader() {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const accountStatus = connection === 'offline' ? 'Offline' : 'Ospite';

  return (
    <header className="border-b border-gray-200 bg-white">
      <a href="#main-content" className="sr-only rounded-lg bg-gray-950 px-3 py-2 text-sm font-bold text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
        Salta al contenuto
      </a>
      <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-3 px-3 sm:px-6 lg:px-8">
        <span className="shrink-0 text-lg font-black tracking-tight text-emerald-800" aria-label="iKuck">iKuck</span>
        <nav aria-label="Navigazione principale" className="min-w-0 flex-1">
          <ul className="grid grid-cols-4 gap-1 sm:flex sm:justify-end sm:gap-2">
            {primaryLinks.map(({ path, label }) => {
              const isCurrent = location.pathname === path;
              return (
                <li key={path}>
                  <Link
                    to={path}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={`flex min-h-10 items-center justify-center rounded-lg px-1 text-xs font-bold sm:px-3 sm:text-sm ${isCurrent ? 'bg-emerald-100 text-emerald-950' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'}`}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        {user === null ? (
          <span className="sr-only sm:not-sr-only sm:shrink-0 sm:text-xs sm:font-semibold sm:text-gray-600" aria-label="Stato account">
            {accountStatus}
          </span>
        ) : (
          <span role="img" aria-label="Profilo connesso" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-700 text-white">
            <UserRound size={17} aria-hidden="true" />
          </span>
        )}
      </div>
    </header>
  );
}
