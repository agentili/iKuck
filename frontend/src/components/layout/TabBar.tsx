import { Package, BookOpen, ShoppingBasket, Clock, UserRound } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { memo } from 'react';

const TAB_ITEMS = [
  { path: '/pantry', label: 'Dispensa', icon: Package },
  { path: '/recipes', label: 'Ricette', icon: BookOpen },
  { path: '/shopping-list', label: 'Spesa', icon: ShoppingBasket },
  { path: '/activity', label: 'Attività', icon: Clock },
  { path: '/profile', label: 'Profilo', icon: UserRound },
] as const;

export const TabBar = memo(() => {
  const location = useLocation();

  return (
    <nav
      role="navigation"
      aria-label="Navigazione principale"
      className="
        fixed bottom-0 left-0 right-0 z-50
        bg-[var(--color-surface)] border-t border-[var(--color-border)]
        pb-[env(safe-area-inset-bottom)]
        shadow-[var(--shadow-surface)]
      "
    >
      <ul className="flex w-full mx-auto px-2">
        {TAB_ITEMS.map(({ path, label, icon: Icon }) => {
                  const isCurrent = location.pathname === path || location.pathname.startsWith(path + '/');
                  return (
            <li key={path} className="flex-1">
              <Link
                to={path}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={label}
                className={`
                  flex flex-col items-center justify-center gap-1
                  px-2 py-2.5 min-h-[56px] min-w-0
                  rounded-[var(--radius-control)] mx-1
                  transition-colors duration-150
                  focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]
                  ${isCurrent
                    ? 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]'}
                `}
              >
                <Icon className="w-6 h-6 stroke-2 shrink-0" aria-hidden="true" />
                <span className="text-xs font-semibold truncate max-w-[5ch]">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});

TabBar.displayName = 'TabBar';