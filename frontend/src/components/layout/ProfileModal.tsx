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
  const toggleTheme = () => saveColorThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');

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
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      
      <div 
        ref={modalRef}
        className="absolute top-20 right-4 left-4 md:right-auto md:w-80 bg-[var(--sc-cream)] border border-[var(--sc-peach-soft)] rounded-2xl shadow-[var(--sc-shadow-lift)] animate-slide-down max-h-[80vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--sc-peach-soft)]">
          <h2 id="profile-modal-title" className="text-lg font-bold text-[var(--sc-ink)]">Profilo</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--sc-ink-faint)] hover:bg-[var(--sc-peach-soft)] transition-colors"
            aria-label="Chiudi"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* User Info */}
        <div className="p-4 border-b border-[var(--sc-peach-soft)]">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--sc-terracotta)] to-[var(--sc-honey)] flex items-center justify-center text-[var(--sc-cream)] text-2xl font-bold">
              {user?.email.charAt(0).toUpperCase() ?? 'O'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-[var(--sc-ink)] truncate">{user?.email.split('@')[0] ?? 'Ospite'}</p>
              <p className="text-sm text-[var(--sc-ink-faint)] truncate">{user?.email ?? 'Dati locali'}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  connection === 'offline' ? 'bg-gray-100 text-gray-700' :
                  user === null ? 'bg-blue-100 text-blue-700' :
                  user.emailVerifiedAt.trim() === '' ? 'bg-amber-100 text-amber-700' :
                  'bg-green-100 text-green-700'
                }`}>
                  {connection === 'offline' && <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />}
                  {connection !== 'offline' && user?.emailVerifiedAt.trim() === '' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                  {connection !== 'offline' && user?.emailVerifiedAt.trim() !== '' && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
                  {accountStatus}
                </span>
              </div>
              <p className="text-xs text-[var(--sc-ink-faint)] mt-1">{scopeLabel}</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 space-y-2">
          <Link
            to="/profile"
            onClick={onClose}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
          >
            <UserRound className="w-5 h-5" aria-hidden="true" />
            <span className="font-medium">Profilo e impostazioni</span>
          </Link>
          
          <Link
            to="/house"
            onClick={onClose}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
          >
            <Home className="w-5 h-5" aria-hidden="true" />
            <span className="font-medium">Casa e condivisione</span>
          </Link>
          
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--sc-ink)] hover:bg-[var(--sc-peach-soft)] transition-colors"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            <span className="font-medium">{resolvedTheme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}</span>
          </button>
          
          {user && (
            <button
              type="button"
              onClick={() => { useAuthStore.getState().logout(); onClose(); }}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--sc-terracotta)] hover:bg-[var(--sc-coral-soft)] transition-colors"
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