import { Link, useLocation } from 'react-router-dom';
import { Clock3, Home, ShoppingBasket, UserRound, WifiOff } from 'lucide-react';
import { useAuthStore } from '../../auth/authStore';

const primaryLinks = [
  { path: '/', label: 'Home', icon: Home },
  { path: '/shopping-list', label: 'Lista', icon: ShoppingBasket },
  { path: '/activity', label: 'Attività', icon: Clock3 },
  { path: '/profile', label: 'Profilo', icon: UserRound },
] as const;

export default function AppHeader() {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const accountStatus = user === null ? (connection === 'offline' ? 'Offline' : 'Ospite') : 'Connesso';

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
      <a href="#main-content" className="sr-only rounded-lg bg-gray-950 px-3 py-2 text-sm font-bold text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
        Salta al contenuto
      </a>
      <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link to="/" aria-label="iKuck" className="shrink-0 rounded-lg text-lg font-black tracking-tight text-emerald-800">iKuck</Link>
        <nav aria-label="Navigazione principale" className="app-navigation fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur sm:static sm:ml-auto sm:border-0 sm:bg-transparent sm:shadow-none">
          <ul className="mx-auto grid max-w-lg grid-cols-4 gap-1 px-2 sm:flex sm:max-w-none sm:justify-end sm:px-0">
            {primaryLinks.map(({ path, label, icon: Icon }) => {
              const isCurrent = path === '/'
                ? location.pathname === '/' || location.pathname.startsWith('/recipes/')
                : location.pathname === path;
              return (
                <li key={path}>
                  <Link
                    to={path}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={`flex min-h-14 items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-xs font-bold sm:min-h-11 sm:flex-row sm:gap-2 sm:px-3 sm:py-2 sm:text-sm ${isCurrent ? 'bg-emerald-100 text-emerald-950' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'}`}
                  >
                    <Icon size={20} strokeWidth={2.25} aria-hidden="true" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${connection === 'offline' ? 'bg-amber-100 text-amber-950' : 'bg-gray-100 text-gray-600'}`} aria-label="Stato account">
          {connection === 'offline' && <WifiOff size={14} aria-hidden="true" />}
          {accountStatus}
        </span>
      </div>
    </header>
  );
}
