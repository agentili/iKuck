import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, Loader2, Mail, RefreshCw, Trash2 } from 'lucide-react';
import type { PantryCandidate } from '../../pantry/pantryCandidatesApi';
import { pantryCandidatesApi, type PantryCandidateActionResult } from '../../pantry/pantryCandidatesApi';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';

const MAX_BATCH = 100;

type RetryAction =
  | { action: 'fetch' }
  | { action: 'accept' | 'ignore'; ids: string[] };

const REASON_MESSAGES: Record<string, string> = {
  not_found: 'L’articolo non è più disponibile.',
  already_resolved: 'L’articolo è già stato gestito.',
  duplicate_in_pantry: 'L’articolo è già presente nella dispensa.',
  invalid_candidate: 'L’articolo non può essere confermato.',
  house_membership_required: 'Serve l’accesso a una Casa.',
  network_error: 'Rete non disponibile. Riprova più tardi.',
  request_failed: 'Richiesta non riuscita. Riprova.',
};

const reasonMessage = (code: string): string => REASON_MESSAGES[code] ?? 'Errore. Riprova più tardi.';

const formatMoment = (value: string | null): string => {
  if (!value) return '';
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

interface CandidatesInboxProps {
  houseId: string | null;
  hideWhenEmpty?: boolean;
}

export default function CandidatesInbox({ houseId, hideWhenEmpty = false }: CandidatesInboxProps) {
  const { user, csrfToken, connection } = useAuthStore();
  const setPendingCount = usePantryCandidatesBadgeStore((state) => state.setPendingCount);
  const setHouse = usePantryCandidatesBadgeStore((state) => state.setHouse);
  const [candidates, setCandidates] = useState<PantryCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const fetchGeneration = useRef(0);

  const isVerified = user !== null && csrfToken !== null && user.emailVerifiedAt.trim().length > 0;
  const ready = isVerified && houseId !== null && connection !== 'offline';

  const loadCandidates = useCallback(async (): Promise<void> => {
    if (!ready || csrfToken === null) return;
    const generation = ++fetchGeneration.current;
    setLoading(true);
    setError(null);
    setRetryAction(null);
    setCandidates([]);
    setSelectedIds(new Set());
    setProcessing(new Set());
    try {
      const { candidates: next } = await pantryCandidatesApi.fetchCandidates(csrfToken);
      if (fetchGeneration.current !== generation) return;
      setCandidates(next);
      setPendingCount(next.length);
    } catch (failure) {
      if (fetchGeneration.current !== generation) return;
      setError({ code: failure instanceof ApiClientError ? failure.code : 'request_failed' });
      setRetryAction({ action: 'fetch' });
    } finally {
      if (fetchGeneration.current === generation) setLoading(false);
    }
  }, [csrfToken, ready, setPendingCount]);

  useEffect(() => {
    if (!ready || csrfToken === null) return;
    setHouse(houseId);
    void loadCandidates();
    return () => { fetchGeneration.current += 1; };
  }, [ready, user?.id, user?.emailVerifiedAt, houseId, csrfToken, connection, loadCandidates, setHouse]);

  const isAllSelected = candidates.length > 0 && candidates.every((candidate) => selectedIds.has(candidate.id));
  const selectedCount = selectedIds.size;

  const toggleCandidate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH) next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
      return;
    }
    const next = new Set<string>();
    for (const candidate of candidates) {
      if (next.size >= MAX_BATCH) break;
      next.add(candidate.id);
    }
    setSelectedIds(next);
  };

  const isProcessing = (id: string) => processing.has(id);

  const runAction = useCallback(async (action: 'accept' | 'ignore', ids: string[]): Promise<void> => {
    if (!ready || csrfToken === null || ids.length === 0) return;
    const generation = fetchGeneration.current;
    const removed = candidates.filter((candidate) => ids.includes(candidate.id));
    setProcessing((prev) => new Set([...prev, ...ids]));
    setSelectedIds(new Set());
    setError(null);
    setRetryAction(null);
    setCandidates((prev) => prev.filter((candidate) => !ids.includes(candidate.id)));
    setPendingCount(Math.max(0, usePantryCandidatesBadgeStore.getState().pendingCount - ids.length));

    const api = action === 'accept' ? pantryCandidatesApi.acceptCandidates : pantryCandidatesApi.ignoreCandidates;
    try {
      const { results } = await api(ids, csrfToken);
      if (fetchGeneration.current !== generation) return;
      const failures = results.filter((result): result is PantryCandidateActionResult & { ok: false } => !result.ok);
      if (failures.length > 0) {
        const failedIds = new Set(failures.map((result) => result.id));
        const restored = removed.filter((candidate) => failedIds.has(candidate.id));
        setCandidates((prev) => [...prev, ...restored]);
        setPendingCount(usePantryCandidatesBadgeStore.getState().pendingCount + restored.length);
        setError({ code: failures[0].code });
        setRetryAction(restored.length > 0 ? { action, ids: restored.map((candidate) => candidate.id) } : null);
      }
    } catch (failure) {
      if (fetchGeneration.current !== generation) return;
      setCandidates((prev) => [...prev, ...removed]);
      setPendingCount(usePantryCandidatesBadgeStore.getState().pendingCount + removed.length);
      setError({ code: failure instanceof ApiClientError ? failure.code : 'request_failed' });
      setRetryAction({ action, ids });
    } finally {
      if (fetchGeneration.current === generation) {
        setProcessing((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }, [csrfToken, candidates, ready, setPendingCount]);

  const handleAccept = () => runAction('accept', [...selectedIds]);
  const handleIgnore = () => runAction('ignore', [...selectedIds]);
  const handleRetry = () => {
    if (retryAction === null) return;
    if (retryAction.action === 'fetch') {
      void loadCandidates();
      return;
    }
    void runAction(retryAction.action, retryAction.ids);
    setRetryAction(null);
  };

  if (!ready || (hideWhenEmpty && candidates.length === 0 && !loading && error === null && processing.size === 0)) return null;

  return (
    <section aria-labelledby="candidates-title" aria-busy={loading} className="ik-surface mt-6 min-w-0 border-2 p-4 text-[var(--ik-ink)] sm:mt-8 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="candidates-title" className="text-lg font-bold text-[var(--ik-ink)]">Da confermare</h2>
          <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">
            Articoli spuntati su Bring! da confermare nella dispensa.
          </p>
        </div>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ik-button-secondary min-h-11 border-2 bg-[var(--ik-surface)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)]"
          >
            Annulla selezione
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="mt-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-sm text-[var(--ik-ink)]">
          {reasonMessage(error.code)}
          <button
            type="button"
            onClick={handleRetry}
            className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-surface)] px-3 py-1.5 text-sm font-bold text-[var(--ik-tomato)] hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)]"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Riprova
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && (
        <p role="status" className="mt-4 flex min-h-12 items-center gap-2 rounded-[var(--ik-radius-panel)] border border-dashed border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-4 py-3 text-sm font-medium text-[var(--ik-ink)]">
          <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" />
          <span>Caricamento degli articoli da confermare…</span>
        </p>
      )}

      {candidates.length === 0 && !loading && error === null && (
        <p role="status" className="mt-4 flex min-h-12 items-center gap-2 rounded-[var(--ik-radius-panel)] border border-dashed border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-4 py-3 text-sm font-medium text-[var(--ik-ink)]">
          <Mail size={18} className="shrink-0" aria-hidden="true" />
          <span>Nessun articolo da confermare.</span>
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <div className="mt-4 grid gap-2" role="list" aria-label={`Candidati da confermare (${candidates.length})`}>
            {candidates.map((candidate) => {
              const isSelected = selectedIds.has(candidate.id);
              const checkedOffLabel = candidate.checkedOffAt
                ? `Spuntato il ${formatMoment(candidate.checkedOffAt)}`
                : `Rilevato il ${formatMoment(candidate.detectedAt)}`;
              return (
                <article
                  key={candidate.id}
                  role="listitem"
                  className={`min-w-0 rounded-[var(--ik-radius-control)] border p-3 ${isSelected
                    ? 'border-[var(--ik-border-strong)] bg-[var(--ik-sage)]'
                    : 'border-[var(--ik-border)] bg-[var(--ik-surface)]'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <input
                        type="checkbox"
                        id={`candidate-${candidate.id}`}
                        checked={isSelected}
                        disabled={isProcessing(candidate.id) || (!isSelected && selectedCount >= MAX_BATCH)}
                        onChange={() => toggleCandidate(candidate.id)}
                        aria-label={`Seleziona ${candidate.label}`}
                        className="mt-1 h-5 w-5 shrink-0 accent-[var(--ik-basil)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)]"
                      />
                      <div className="min-w-0">
                        <label htmlFor={`candidate-${candidate.id}`} className="block font-bold text-[var(--ik-ink)]">
                          {candidate.label}
                        </label>
                        {candidate.specification !== '' && (
                          <p className="mt-0.5 break-words text-sm text-[var(--ik-ink-muted)]">{candidate.specification}</p>
                        )}
                        <p className="mt-1 break-words text-xs text-[var(--ik-ink-muted)]">
                          <span className="font-semibold">Da {candidate.listName}</span> · {checkedOffLabel}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ik-mist)] px-2 py-1 text-xs font-semibold text-[var(--ik-ink-muted)]">
                      In attesa
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-5 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={candidates.length === 0}
              className="ik-button-secondary min-h-11 w-full border-2 bg-[var(--ik-surface)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit"
            >
              {isAllSelected ? 'Deseleziona tutto' : 'Seleziona tutto'}
            </button>
            <span className="text-sm font-semibold text-[var(--ik-ink-muted)] sm:text-center">
              {selectedCount} {selectedCount === 1 ? 'selezionato' : 'selezionati'}
            </span>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex">
              <button
                type="button"
                onClick={handleIgnore}
                disabled={selectedCount === 0}
                aria-label="Ignora selezionati"
                className="inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-surface)] px-4 py-2 text-sm font-bold text-[var(--ik-tomato)] hover:bg-[var(--ik-tomato-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                <Trash2 size={16} aria-hidden="true" /> Ignora
              </button>
              <button
                type="button"
                onClick={handleAccept}
                disabled={selectedCount === 0}
                aria-label="Accetta selezionati"
                className="ik-button-primary inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 border-2 border-[var(--ik-basil)] px-4 py-2 text-sm font-bold hover:border-[var(--ik-basil-dark)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                <CheckCheck size={16} aria-hidden="true" /> Accetta
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
