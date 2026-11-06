import { memo, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { UserRound, Moon, Sun, Home, LogOut, X } from 'lucide-react';
import { useAuthStore } from '../../auth/authStore';
import { useHouseStore } from '../../house/houseStore';
import { resolveColorTheme, saveColorThemePreference, subscribeColorTheme } from '../../domain/colorTheme';
import { useSyncExternalStore } from 'react';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal = memo(({ isOpen, onClose }: ProfileModalProps) => {
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const house = useHouseStore((state) => state.state?.house ?? null);
  const resolvedTheme = useSyncExternalStore(subscribeColorTheme, resolveColorTheme, () => 'light');
  
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const toggleTheme = () => saveColorThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    return () => {
      if (previouslyFocusedRef.current?.isConnected) previouslyFocusedRef.current.focus();
      previouslyFocusedRef.current = null;
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  // Trap focus
  useEffect(() => {
    if (!isOpen) return;
    const focusableElements = modalRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusableElements?.length) return;
    
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
    
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };
    
    document.addEventListener('keydown', handleTab);
    firstElement?.focus();
    return () => document.removeEventListener('keydown', handleTab);
  }, [isOpen]);

  const accountStatus = connection === 'offline'
    ? 'Offline'
    : user === null
      ? 'Ospite'
      : user.emailVerifiedAt.trim() === ''
        ? 'Account non verificato'
        : 'Account verificato';
  
  const scopeLabel = house === null ? 'Ambito personale' : `Casa · ${house.name}`;

  if (!isOpen) return null;

  return (
    <div id="profile-modal" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
      <div className="ik-modal-backdrop absolute inset-0" onClick={onClose} />
      
      <div 
        ref={modalRef}
        className="ik-modal-surface absolute top-20 right-4 left-4 md:right-auto md:w-80 rounded-2xl animate-slide-down max-h-[80vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--ik-border)]">
          <h2 id="profile-modal-title" className="text-lg font-bold text-[var(--ik-ink)]">Profilo</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--ik-ink-muted)] hover:bg-[var(--ik-sage)] transition-colors"
            aria-label="Chiudi"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* User Info */}
        <div className="p-4 border-b border-[var(--ik-border)]">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[var(--ik-basil-dark)] flex items-center justify-center text-[var(--ik-porcelain)] text-2xl font-bold">
              {user?.email.charAt(0).toUpperCase() ?? 'O'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-[var(--ik-ink)] truncate">{user?.email.split('@')[0] ?? 'Ospite'}</p>
              <p className="text-sm text-[var(--ik-ink-muted)] truncate">{user?.email ?? 'Dati locali'}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  connection === 'offline' ? 'bg-[var(--ik-mist)] text-[var(--ik-ink-muted)]' :
                  user === null ? 'bg-[var(--ik-sage)] text-[var(--ik-ink)]' :
                  user.emailVerifiedAt.trim() === '' ? 'bg-[var(--ik-yolk-soft)] text-[var(--ik-warn-ink)]' :
                  'bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'
                }`}>
                  {connection === 'offline' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--ik-ink-muted)]" />}
                  {connection !== 'offline' && user?.emailVerifiedAt.trim() === '' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--ik-yolk)]" />}
                  {connection !== 'offline' && user?.emailVerifiedAt.trim() !== '' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--ik-basil)]" />}
                  {accountStatus}
                </span>
              </div>
              <p className="text-xs text-[var(--ik-ink-muted)] mt-1">{scopeLabel}</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 space-y-2">
          <Link
            to="/profile"
            onClick={onClose}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--ik-ink)] hover:bg-[var(--ik-sage)] transition-colors"
          >
            <UserRound className="w-5 h-5" aria-hidden="true" />
            <span className="font-medium">Profilo e impostazioni</span>
          </Link>
          
          <Link
            to="/house"
            onClick={onClose}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--ik-ink)] hover:bg-[var(--ik-sage)] transition-colors"
          >
            <Home className="w-5 h-5" aria-hidden="true" />
            <span className="font-medium">Casa e condivisione</span>
          </Link>
          
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--ik-ink)] hover:bg-[var(--ik-sage)] transition-colors"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            <span className="font-medium">{resolvedTheme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}</span>
          </button>
          
          {user && (
            <button
              type="button"
              onClick={() => { useAuthStore.getState().logout(); onClose(); }}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--ik-tomato)] hover:bg-[var(--ik-tomato-soft)] transition-colors"
            >
              <LogOut className="w-5 h-5" aria-hidden="true" />
              <span className="font-medium">Esci</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

ProfileModal.displayName = 'ProfileModal';