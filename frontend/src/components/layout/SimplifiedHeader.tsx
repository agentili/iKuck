import { memo, useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { UserRound, Moon, Sun, Menu } from 'lucide-react';
import { useAuthStore } from '../../auth/authStore';
import { useHouseStore } from '../../house/houseStore';
import { resolveColorTheme, saveColorThemePreference, subscribeColorTheme } from '../../domain/colorTheme';
import { useSyncExternalStore } from 'react';
import { isSimplifiedHeader } from '../../config/features';

interface SimplifiedHeaderProps {
  onMenuClick?: () => void;
}

export const SimplifiedHeader = memo(({ onMenuClick }: SimplifiedHeaderProps) => {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const house = useHouseStore((state) => state.state?.house ?? null);
  const resolvedTheme = useSyncExternalStore(subscribeColorTheme, resolveColorTheme, () => 'light');
  
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const toggleTheme = () => saveColorThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');

  // Close profile menu on outside click
  useEffect(() => {
    if (!isProfileOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isProfileOpen]);

  const accountStatus = connection === 'offline'
    ? 'Offline'
    : user === null
      ? 'Ospite'
      : user.emailVerifiedAt.trim() === ''
        ? 'Non verificato'
        : 'Verificato';
  
  const scopeLabel = house === null ? 'Personale' : `Casa · ${house.name}`;

  if (!isSimplifiedHeader()) return null;

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-[var(--sc-cream)]/95 backdrop-blur-sm border-b border-[var(--sc-peach-soft)]" role="banner">
      <div className="mx-auto flex items-center justify-between gap-3 px-4 py-3 max-w-xl">
        {/* Left: Logo + Menu button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onMenuClick}
            className="p-2 rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
            aria-label="Menu"
            aria-expanded={false}
          >
            <Menu className="w-6 h-6" aria-hidden="true" />
          </button>
          <Link to="/" aria-label="iKuck" className="shrink-0 text-xl font-black tracking-tight text-[var(--sc-terracotta)]">
            iKuck
          </Link>
        </div>

        {/* Center: Page title (optional) */}
        <div className="flex-1 text-center hidden sm:block">
          <h1 className="text-sm font-semibold text-[var(--sc-ink-faint)] truncate">
            {location.pathname === '/' ? 'Chef' : 
             location.pathname.startsWith('/discover') ? 'Cerca' :
             location.pathname.startsWith('/plan') ? 'Piano' :
             location.pathname.startsWith('/saved') ? 'Salvate' : 'iKuck'}
          </h1>
        </div>

        {/* Right: Theme + Profile */}
        <div className="flex items-center gap-2">
          {/* Theme Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={resolvedTheme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}
            className="grid min-h-10 min-w-10 place-items-center rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
          </button>

          {/* Profile Menu */}
          <div className="relative" ref={profileRef}>
            <button
              type="button"
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="grid min-h-10 min-w-10 place-items-center rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
              aria-label="Profilo"
              aria-expanded={isProfileOpen}
              aria-haspopup="true"
            >
              <UserRound className="w-5 h-5" aria-hidden="true" />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-[var(--sc-cream)] border border-[var(--sc-peach-soft)] rounded-2xl shadow-[var(--sc-shadow-card)] py-2 z-50 animate-slide-down">
                <div className="px-4 py-3 border-b border-[var(--sc-peach-soft)]">
                  <p className="font-bold text-[var(--sc-ink)] truncate">{user?.email.split('@')[0] ?? 'Ospite'}</p>
                  <p className="text-xs text-[var(--sc-ink-faint)] truncate">{user?.email ?? 'Dati locali'}</p>
                  <p className="text-xs text-[var(--sc-ink-faint)] mt-1">{accountStatus} · {scopeLabel}</p>
                </div>
                
                <nav className="py-2">
                  <Link
                    to="/profile"
                    className="flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)]"
                    onClick={() => setIsProfileOpen(false)}
                  >
                    <UserRound className="w-5 h-5" aria-hidden="true" />
                    Profilo
                  </Link>
                  <Link
                    to="/house"
                    className="flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)]"
                    onClick={() => setIsProfileOpen(false)}
                  >
                    <span className="w-5 h-5">🏠</span>
                    Casa
                  </Link>
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="flex items-center gap-3 w-full px-4 py-2 text-sm font-medium text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] text-left"
                  >
                    {resolvedTheme === 'dark' ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
                    {resolvedTheme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}
                  </button>
                  {user && (
                    <button
                      type="button"
                      onClick={() => { useAuthStore.getState().logout(); setIsProfileOpen(false); }}
                      className="flex items-center gap-3 w-full px-4 py-2 text-sm font-medium text-[var(--sc-terracotta)] hover:bg-[var(--sc-peach-soft)] text-left"
                    >
                      <span className="w-5 h-5">🚪</span>
                      Esci
                    </button>
                  )}
                </nav>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
});

SimplifiedHeader.displayName = 'SimplifiedHeader';