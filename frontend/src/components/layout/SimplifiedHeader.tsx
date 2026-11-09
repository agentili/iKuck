import { memo, useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import { useAuthStore } from '../../auth/authStore';
import { useHouseStore } from '../../house/houseStore';
import { isSimplifiedHeader } from '../../config/features';

export const SimplifiedHeader = memo(() => {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const house = useHouseStore((state) => state.state?.house ?? null);
  
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  // Close profile menu on outside click
  useEffect(() => {
    if (!isProfileOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsProfileOpen(false);
      profileButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
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
    <header className="ik-app-header sous-chef-header fixed top-0 left-0 right-0 z-40 border-b border-[var(--ik-border)]" role="banner">
      <div className="sous-chef-header-inner mx-auto flex items-center justify-between gap-3 px-4 py-3 max-w-xl">
        {/* Left: Logo */}
        <div className="sous-chef-header-leading flex items-center gap-3">
          <Link to="/" aria-label="iKuck" className="shrink-0 text-xl font-black tracking-tight text-[var(--ik-basil-dark)]">
            iKuck
          </Link>
        </div>

        {/* Center: Page title (optional) */}
        <div className="flex-1 text-center hidden sm:block">
          <span aria-hidden="true" className="text-sm font-semibold text-[var(--ik-ink-muted)] truncate">
            {location.pathname === '/' ? 'Chef' : 
             location.pathname.startsWith('/discover') ? 'Cerca' :
             location.pathname.startsWith('/plan') ? 'Piano' :
             location.pathname.startsWith('/saved') ? 'Salvate' : 'iKuck'}
          </span>
        </div>

        {/* Right: Profile */}
        <div className="sous-chef-header-actions flex items-center gap-2">
          {/* Profile Menu */}
          <div className="relative" ref={profileRef}>
            <button
              type="button"
              ref={profileButtonRef}
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="sous-chef-header-icon-button grid min-h-10 min-w-10 place-items-center rounded-xl text-[var(--ik-ink)] hover:bg-[var(--ik-sage)] transition-colors"
              aria-label="Profilo"
              aria-expanded={isProfileOpen}
              aria-haspopup="true"
            >
              <UserRound className="w-5 h-5" aria-hidden="true" />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-[var(--ik-porcelain)] border border-[var(--ik-sage)] rounded-2xl shadow-[var(--ik-shadow-card)] py-2 z-50 animate-slide-down">
                <div className="px-4 py-3 border-b border-[var(--ik-sage)]">
                  <p className="font-bold text-[var(--ik-ink)] truncate">{user?.email.split('@')[0] ?? 'Ospite'}</p>
                  <p className="text-xs text-[var(--ik-ink-muted)] truncate">{user?.email ?? 'Dati locali'}</p>
                  <p className="text-xs text-[var(--ik-ink-muted)] mt-1">{accountStatus} · {scopeLabel}</p>
                </div>
                
                <nav className="py-2">
                  <Link
                    to="/profile"
                    className="flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--ik-ink)] hover:bg-[var(--ik-sage)]"
                    onClick={() => setIsProfileOpen(false)}
                  >
                    <UserRound className="w-5 h-5" aria-hidden="true" />
                    Profilo
                  </Link>
                  <Link
                    to="/house"
                    className="flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--ik-ink)] hover:bg-[var(--ik-sage)]"
                    onClick={() => setIsProfileOpen(false)}
                  >
                    <span className="w-5 h-5">🏠</span>
                    Casa
                  </Link>
                  {user && (
                    <button
                      type="button"
                      onClick={() => { useAuthStore.getState().logout(); setIsProfileOpen(false); }}
                      className="flex items-center gap-3 w-full px-4 py-2 text-sm font-medium text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)] text-left"
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
