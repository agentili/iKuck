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
    <div role="status" aria-live="polite" className="app-overlay fixed inset-x-4 z-50 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-2xl bg-gray-950 px-4 py-3 text-white shadow-xl">
      <span>{message}</span>
      <button type="button" onClick={onUndo} className="min-h-10 shrink-0 rounded-xl bg-white px-3 py-2 font-bold text-gray-950 hover:bg-gray-100">
        Annulla
      </button>
    </div>
  );
}
