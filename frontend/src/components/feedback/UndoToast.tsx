import { useEffect } from 'react';

interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onExpire: () => void;
  durationMs?: number;
}

export default function UndoToast({ message, onUndo, onExpire, durationMs = 6000 }: UndoToastProps) {
  useEffect(() => {
    const timeoutId = window.setTimeout(onExpire, durationMs);
    return () => window.clearTimeout(timeoutId);
  }, [durationMs, onExpire]);

  return (
    <div role="status" aria-live="polite" className="app-overlay fixed inset-x-4 z-50 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-[var(--ik-radius-panel)] bg-[var(--ik-ink)] px-4 py-3 text-[var(--ik-porcelain)] shadow-xl">
      <span>{message}</span>
      <button type="button" onClick={onUndo} className="min-h-10 shrink-0 rounded-[var(--ik-radius-control)] bg-[var(--ik-yolk)] px-3 py-2 font-bold text-[var(--ik-on-yolk)] hover:bg-[var(--ik-yolk-hover)]">
        Annulla
      </button>
    </div>
  );
}
