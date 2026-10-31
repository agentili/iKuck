import { memo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChefHat, Calendar, BookOpen, PackageOpen, ShoppingBasket } from 'lucide-react';
import { isBottomNav } from '../../config/features';

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

export const BottomNav = memo(() => {
  const location = useLocation();

  if (!isBottomNav()) return null;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-[var(--sc-cream)] border-t border-[var(--sc-peach-soft)] px-[4px] pt-2 sm:px-4"
      style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
      role="navigation"
      aria-label="Navigazione principale"
    >
      <div className="mx-auto flex w-full max-w-xl">
        {navItems.map(({ path, label, short, icon: Icon }) => {
          const isCurrent = location.pathname === path || (path !== '/' && location.pathname.startsWith(path + '/'));
          return (
            <Link
              key={path}
              to={path}
              aria-label={label}
              aria-current={isCurrent ? 'page' : undefined}
              className={`flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-2 transition-colors ${
                isCurrent
                  ? 'bg-[var(--sc-peach-soft)] text-[var(--sc-terracotta)]'
                  : 'text-[var(--sc-ink-faint)] hover:bg-[var(--sc-peach-soft)] hover:text-[var(--sc-terracotta)]'
              }`}
            >
              <Icon className="h-5 w-5 shrink-0 stroke-2" aria-hidden="true" />
              <span aria-hidden="true" className="w-full text-center text-[0.6875rem] font-semibold leading-tight">
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