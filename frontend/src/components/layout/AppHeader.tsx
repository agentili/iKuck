import { useSyncExternalStore } from 'react';
import { BookOpen, ChefHat, Home, Moon, PackageOpen, ShoppingBasket, Sun, UserRound, WifiOff } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../auth/authStore';
import { useHouseStore } from '../../house/houseStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';
import { resolveColorTheme, saveColorThemePreference, subscribeColorTheme } from '../../domain/colorTheme';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

const subscribeConnectivity = (listener: () => void) => {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
};
const getConnectivity = () => navigator.onLine;

const primaryLinks = [
  { path: '/', label: 'Cucina', compactLabel: 'Cucina', narrowLabel: 'Cucina', icon: Home },
  { path: '/recipes', label: 'Ricette', compactLabel: 'Ricette', narrowLabel: 'Ric.', icon: ChefHat },
  { path: '/pantry', label: 'Dispensa', compactLabel: 'Dispensa', narrowLabel: 'Disp.', icon: PackageOpen },
  { path: '/shopping-list', label: 'Spesa', compactLabel: 'Spesa', narrowLabel: 'Spesa', icon: ShoppingBasket },
  { path: '/dinner-diary', label: 'Diario', compactLabel: 'Diario', narrowLabel: 'Diario', icon: BookOpen },
] as const;

interface AppHeaderProps {
  scopeUnverified?: boolean;
}

export default function AppHeader({ scopeUnverified = false }: AppHeaderProps) {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const house = useHouseStore((state) => state.state?.house ?? null);
  const pendingCount = usePantryCandidatesBadgeStore((state) => state.pendingCount);
  const activeScope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const browserOnline = useSyncExternalStore(subscribeConnectivity, getConnectivity, () => true);
  const offline = connection === 'offline' || !browserOnline;
  const resolvedTheme = useSyncExternalStore(subscribeColorTheme, resolveColorTheme, () => 'light');
  const toggleTheme = () => {
    saveColorThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');
  };
  const renderThemeToggle = () => (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={resolvedTheme === 'dark' ? 'Attiva tema chiaro' : 'Attiva tema scuro'}
      className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-800 hover:bg-gray-100"
    >
      {resolvedTheme === 'dark' ? <Sun size={19} aria-hidden="true" /> : <Moon size={19} aria-hidden="true" />}
    </button>
  );
  const accountStatus = user === null
      ? 'Ospite · dati locali'
      : user.emailVerifiedAt.trim() === '' ? 'Account non verificato' : 'Account verificato';
  const scopeLabel = scopeUnverified
    ? 'Ambito da verificare'
    : activeScope === 'guest' ? 'Dati ospite sul dispositivo'
      : activeScope.startsWith('house:')
        ? house !== null && activeScope === `house:${house.id}` ? `Casa · ${house.name}` : 'Dati della Casa'
        : 'Dati personali';

  return (
    <header className="ik-app-header app-sidebar fixed left-0 top-0 z-40 flex h-auto w-full flex-col border-b border-gray-200 bg-white">
      <a href="#main-content" className="sr-only rounded-lg bg-gray-950 px-3 py-2 text-sm font-bold text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
        Salta al contenuto
      </a>
      <div className="app-sidebar-brand flex min-h-14 items-center justify-between gap-3 border-b border-gray-200 px-4 sm:px-6 lg:px-7">
        <Link to="/" aria-label="A tavola" className="shrink-0 rounded-lg text-xl font-black tracking-tight text-emerald-900">A tavola<span className="brand-caption">La cucina di ogni giorno</span></Link>
        <div className="app-header-context" role="status" aria-label="Stato account e dati">
          <span className="app-header-account">{accountStatus}</span>
          <span className="app-header-scope">{scopeLabel}</span>
          {offline && <span className="app-header-offline"><WifiOff size={14} aria-hidden="true" /> Offline</span>}
        </div>
        <div className="app-mobile-links items-center gap-1">
          <Link to="/profile" aria-label="Profilo" className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-800 hover:bg-gray-100"><UserRound size={19} aria-hidden="true" /></Link>
          <Link to="/house" aria-label="Casa" className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-800 hover:bg-gray-100"><Home size={19} aria-hidden="true" /></Link>
          {renderThemeToggle()}
        </div>
      </div>
      <nav aria-label="Navigazione principale" className="app-navigation fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white sm:static sm:ml-auto sm:border-0 sm:bg-transparent">
        <ul className="mx-auto grid max-w-lg grid-cols-5 gap-1 px-2 sm:flex sm:max-w-none sm:justify-end sm:px-0">
          {primaryLinks.map(({ path, label, compactLabel, narrowLabel, icon: Icon }) => {
            const isCurrent = path === '/'
              ? location.pathname === '/'
              : path === '/recipes'
                ? location.pathname === '/recipes' || location.pathname.startsWith('/recipes/')
                : path === '/dinner-diary'
                  ? location.pathname === path || location.pathname === '/activity'
                  : location.pathname === path;
            const linkAriaLabel =
              path === '/pantry' && pendingCount > 0
                ? `${label} (${pendingCount} da confermare)`
                : label;
            const pantryBadge =
              path === '/pantry' && pendingCount > 0 ? (
                <span
                  className="ml-1 inline-block min-h-6 min-w-6 rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-900"
                  aria-label={`${pendingCount} articoli da confermare`}
                >
                  {pendingCount}
                </span>
              ) : null;
            return (
              <li key={path} className="min-w-0">
                <Link
                  to={path}
                  aria-label={linkAriaLabel}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-center text-xs font-bold leading-tight sm:min-h-11 sm:flex-row sm:gap-2 sm:px-3 sm:py-2 sm:text-sm ${isCurrent ? 'bg-emerald-100 text-emerald-950' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'}`}
                >
                  <Icon size={20} strokeWidth={2.25} aria-hidden="true" />
                  <span className="app-navigation-label-full min-w-0">{label}</span>
                  <span className="app-navigation-label-compact min-w-0" aria-hidden="true">{compactLabel}</span>
                  <span className="app-navigation-label-narrow min-w-0" aria-hidden="true">{narrowLabel}</span>
                  {pantryBadge}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="app-sidebar-account mt-auto border-t border-gray-200 p-4">
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/profile" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-gray-300 px-3 py-2 text-sm font-bold text-gray-800 hover:bg-gray-50"><UserRound size={16} aria-hidden="true" /> Profilo</Link>
          <Link to="/house" className="inline-flex min-h-11 items-center rounded-xl border border-gray-300 px-3 py-2 text-sm font-bold text-gray-800 hover:bg-gray-50">Casa</Link>
          {renderThemeToggle()}
        </div>
      </div>
    </header>
  );
}
