import { memo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChefHat, Search, Calendar, BookOpen } from 'lucide-react';
import { isBottomNav } from '../../config/features';

const navItems = [
  { path: '/', label: 'Chef', icon: ChefHat },
  { path: '/discover', label: 'Cerca', icon: Search },
  { path: '/plan', label: 'Piano', icon: Calendar },
  { path: '/saved', label: 'Salvate', icon: BookOpen },
] as const;

export const BottomNav = memo(() => {
  const location = useLocation();

  if (!isBottomNav()) return null;
  
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[var(--sc-cream)] border-t border-[var(--sc-peach-soft)] px-2 py-2 sm:px-4" role="navigation" aria-label="Navigazione principale">
      <div className="mx-auto flex justify-around max-w-xl">
        {navItems.map(({ path, label, icon: Icon }) => {
          const isCurrent = location.pathname === path || (path !== '/' && location.pathname.startsWith(path + '/'));
          return (
            <Link
              key={path}
              to={path}
              aria-current={isCurrent ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors min-w-[60px] ${
                isCurrent
                  ? 'bg-[var(--sc-peach-soft)] text-[var(--sc-terracotta)]'
                  : 'text-[var(--sc-ink-faint)] hover:bg-[var(--sc-peach-soft)] hover:text-[var(--sc-terracotta)]'
              }`}
            >
              <Icon className="w-6 h-6 stroke-2" aria-hidden="true" />
              <span className="text-xs font-semibold">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
});

BottomNav.displayName = 'BottomNav';