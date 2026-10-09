const MOTION_PREFERENCE_KEY = 'ikuck-motion-preference';
let sessionReducedMotionPreference: boolean | null = null;
let sessionPreferencePersistenceFailed = false;

export const hasUnpersistedMotionPreference = (): boolean => sessionReducedMotionPreference !== null && sessionPreferencePersistenceFailed;

export const isReducedMotionPreference = (): boolean => {
  if (sessionReducedMotionPreference !== null) return sessionReducedMotionPreference;
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MOTION_PREFERENCE_KEY) === 'reduced';
  } catch {
    return false;
  }
};

export const applyMotionPreference = (): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motion = isReducedMotionPreference() ? 'reduced' : 'system';
};

export const saveReducedMotionPreference = (reduced: boolean): boolean => {
  if (typeof document === 'undefined') return false;
  let persisted = false;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MOTION_PREFERENCE_KEY, reduced ? 'reduced' : 'system');
      persisted = true;
    }
  } catch {
    persisted = false;
  }
  sessionReducedMotionPreference = persisted ? null : reduced;
  sessionPreferencePersistenceFailed = !persisted;
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'system';
  return persisted;
};
