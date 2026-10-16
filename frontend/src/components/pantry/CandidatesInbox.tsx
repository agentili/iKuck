import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, Loader2, Mail, Trash2 } from 'lucide-react';
import type { PantryCandidate } from '../../pantry/pantryCandidatesApi';
import { pantryCandidatesApi, type PantryCandidateActionResult } from '../../pantry/pantryCandidatesApi';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';

const MAX_BATCH = 100;

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
}

export default function CandidatesInbox({ houseId }: CandidatesInboxProps) {
  const { user, csrfToken, connection } = useAuthStore();
  const setPendingCount = usePantryCandidatesBadgeStore((state) => state.setPendingCount);
  const setHouse = usePantryCandidatesBadgeStore((state) => state.setHouse);
  const [candidates, setCandidates] = useState<PantryCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [retryAction, setRetryAction] = useState<{ action: 'accept' | 'ignore'; ids: string[] } | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const fetchGeneration = useRef(0);

  const isVerified = user !== null && csrfToken !== null && user.emailVerifiedAt.trim().length > 0;
  const ready = isVerified && houseId !== null && connection !== 'offline';

  useEffect(() => {
    if (!ready || csrfToken === null) return;
    setHouse(houseId);
    const generation = ++fetchGeneration.current;
    setLoading(true);
    setError(null);
    setRetryAction(null);
    void pantryCandidatesApi.fetchCandidates(csrfToken).then(({ candidates: next }) => {
      if (fetchGeneration.current !== generation) return;
      setCandidates(next);
      setPendingCount(next.length);
      setLoading(false);
    }).catch((failure) => {
      if (fetchGeneration.current !== generation) return;
      setLoading(false);
      setError({ code: failure instanceof ApiClientError ? failure.code : 'request_failed' });
    });
  }, [ready, houseId, csrfToken, connection, setPendingCount, setHouse]);

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
    if (csrfToken === null) return;
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
      const failures = results.filter((result): result is PantryCandidateActionResult & { ok: false } => !result.ok);
      if (failures.length > 0) {
        const failedIds = new Set(failures.map((result) => result.id));
        const restored = removed.filter((candidate) => failedIds.has(candidate.id));
        setCandidates((prev) => [...prev, ...restored]);
        setPendingCount(usePantryCandidatesBadgeStore.getState().pendingCount + restored.length);
        setError({ code: failures[0].code });
        setRetryAction({ action, ids });
      }
    } catch (failure) {
      setCandidates((prev) => [...prev, ...removed]);
      setPendingCount(usePantryCandidatesBadgeStore.getState().pendingCount + removed.length);
      setError({ code: failure instanceof ApiClientError ? failure.code : 'request_failed' });
      setRetryAction({ action, ids });
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [csrfToken, candidates, setPendingCount]);

  const handleAccept = () => runAction('accept', [...selectedIds]);
  const handleIgnore = () => runAction('ignore', [...selectedIds]);
  const handleRetry = () => {
    if (retryAction === null) return;
    void runAction(retryAction.action, retryAction.ids);
    setRetryAction(null);
  };

  if (!ready) return null;

  return (
    <section aria-label="Da confermare" className="ik-surface mt-6 rounded-3xl border-2 border-emerald-200 bg-white p-4 shadow-sm sm:mt-8 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="candidates-title" className="text-lg font-bold text-gray-950">Da confermare</h2>
          <p className="mt-1 text-sm text-gray-600">
            Articoli spuntati su Bring! da confermare nella dispensa.
          </p>
        </div>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="min-h-10 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50"
          >
            Annulla selezione
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950">
          {reasonMessage(error.code)}
          <button
            type="button"
            onClick={handleRetry}
            className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-bold text-red-800 hover:bg-red-100"
          >
            <Trash2 size={14} aria-hidden="true" />
            Riprova
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && (
        <p role="status" className="mt-4 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950">
          <Loader2 size={16} className="mr-2" aria-hidden="true" />
          Caricamento degli articoli da confermare…
        </p>
      )}

      {candidates.length === 0 && !loading && (
        <p role="status" className="mt-4 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950">
          <Mail size={18} aria-hidden="true" />
          Nessun articolo da confermare.
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
                  className={`rounded-xl border p-3 ${isSelected ? 'bg-emerald-50 border-emerald-200' : 'border-gray-200 bg-white'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-start gap-3 min-w-0">
                      <input
                        type="checkbox"
                        id={`candidate-${candidate.id}`}
                        checked={isSelected}
                        disabled={isProcessing(candidate.id) || (!isSelected && selectedCount >= MAX_BATCH)}
                        onChange={() => toggleCandidate(candidate.id)}
                        aria-label={`Seleziona ${candidate.label}`}
                        className="mt-1 h-5 w-5 accent-emerald-700 shrink-0"
                      />
                      <div className="min-w-0">
                        <label htmlFor={`candidate-${candidate.id}`} className="block font-bold text-gray-950 truncate">
                          {candidate.label}
                        </label>
                        {candidate.specification !== '' && (
                          <p className="mt-0.5 text-sm text-gray-600 truncate">{candidate.specification}</p>
                        )}
                        <p className="mt-1 text-xs text-gray-500 truncate">
                          <span className="font-semibold">Da {candidate.listName}</span> · {checkedOffLabel}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-gray-400 shrink-0 whitespace-nowrap">
                      Pending
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={candidates.length === 0}
              className="min-h-10 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAllSelected ? 'Deseleziona tutto' : 'Seleziona tutto'}
            </button>
            <span className="text-sm font-semibold text-gray-700">
              {selectedCount} {selectedCount === 1 ? 'selezionato' : 'selezionati'}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleIgnore}
                disabled={selectedCount === 0}
                aria-label="Ignora selezionati"
                className="min-h-11 rounded-xl border border-transparent bg-transparent px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 size={16} aria-hidden="true" /> Ignora
              </button>
              <button
                type="button"
                onClick={handleAccept}
                disabled={selectedCount === 0}
                aria-label="Accetta selezionati"
                className="min-h-11 rounded-xl border-2 border-emerald-800 bg-emerald-800 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-900 disabled:opacity-50 disabled:cursor-not-allowed"
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
