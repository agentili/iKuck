import { memo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChefHat, Calendar, BookOpen, PackageOpen, ShoppingBasket } from 'lucide-react';

// T02 shell: exactly five destinations with Chef in the centre.
// «Cerca» and «Salvate» from the prototype are gone: their functionality lives
// in /recipes (live search + saved/AI sections) and both routes stay reachable
// by direct entry.
const navItems = [
  { path: '/pantry', label: 'Dispensa', short: 'Disp.', icon: PackageOpen },
  { path: '/shopping-list', label: 'Spesa', short: 'Sp.', icon: ShoppingBasket },
  { path: '/', label: 'Chef', short: 'Chef', icon: ChefHat },
  { path: '/plan', label: 'Piano', short: 'Pi.', icon: Calendar },
  { path: '/recipes', label: 'Ricette', short: 'Ric.', icon: BookOpen },
] as const;

const normalizePathname = (pathname: string): string => {
  const normalized = pathname.toLowerCase();
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
};

const isCurrentDestination = (pathname: string, path: string): boolean => {
  const currentPath = normalizePathname(pathname);

  if (path === '/') return currentPath === '/' || currentPath === '/cucina';
  if (path === '/recipes') {
    return currentPath === '/recipes'
      || ['/discover', '/saved', '/dinner-diary', '/activity'].includes(currentPath)
      || /^\/recipes\/[^/]+$/.test(currentPath);
  }
  return currentPath === path;
};

export const BottomNav = memo(() => {
  const location = useLocation();

  return (
    <nav
      className="ik-navigation-surface fixed bottom-0 left-0 right-0 z-40 border-t px-[4px] pt-0 sm:px-4"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      role="navigation"
      aria-label="Navigazione principale"
    >
      <div className="mx-auto flex w-full max-w-xl">
        {navItems.map(({ path, label, short, icon: Icon }) => {
          const isCurrent = isCurrentDestination(location.pathname, path);
          return (
            <Link
              key={path}
              to={path}
              aria-label={label}
              aria-current={isCurrent ? 'page' : undefined}
              className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-[2px] rounded-xl px-[2px] py-0 transition-colors ${
                isCurrent
                  ? 'bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'
                  : 'text-[var(--ik-ink-muted)] hover:bg-[var(--ik-sage)] hover:text-[var(--ik-basil-dark)]'
              }`}
            >
              <Icon className="h-[20px] w-[20px] shrink-0 stroke-2" aria-hidden="true" />
              <span aria-hidden="true" className="ik-bottom-nav-label w-full whitespace-nowrap text-center text-[0.6875rem] font-semibold leading-none">
                <span className="hidden min-[361px]:inline">{label}</span><span className="min-[361px]:hidden">{short}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
});

BottomNav.displayName = 'BottomNav';