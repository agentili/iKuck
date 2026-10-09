import type { StateStorage } from 'zustand/middleware';
import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import type { ParsedIngredient } from '../domain/types';
import {
  deleteKeyValue,
  deleteKeyValueIfValue,
  commitPantryRecoverySnapshot,
  finalizePantryRecoverySnapshot,
  isIndexedDbAvailable,
  readKeyValue,
  updateKeyValue,
  writeKeyValue,
  type KeyValueCompareAndWrite,
} from './indexedDb';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { ScopeUncertainError, trackScopedWrite } from '../sync/scopeWriteFence';

let pantryPersistenceSuspended = false;
const pendingPantrySnapshots = new Map<SyncScope, string>();
const latestPantryRevisions = new Map<SyncScope, number>();
const knownObsoleteLocalMirrors = new Map<SyncScope, string | null>();
const pantryWriteLocks = new Map<SyncScope, Promise<void>>();
const observedPantryCanonicalSnapshots = new Map<SyncScope, string | null>();
const activePantryConflicts = new Map<SyncScope, PantrySnapshotConflictError>();
const pendingIndexedDbStorageKey = (scope: SyncScope): string => `${scopedPantryStorageKey(scope)}-idb-pending`;
const obsoleteMirrorDatabaseKey = (scope: SyncScope): string => `${scopedPantryDatabaseKey(scope)}-mirror-obsolete`;

interface PantryWebLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

const withLocalPantryWriteLock = async <T>(scope: SyncScope, operation: () => Promise<T>): Promise<T> => {
  const manager = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: PantryWebLockManager }).locks;
  if (manager === undefined) {
    throw new Error('Pantry snapshot could not be persisted because Web Locks are required for cross-tab pantry mutations');
  }

  let operationStarted = false;
  try {
    return await manager.request(`ikuck:pantry:${scope}`, { mode: 'exclusive' }, async () => {
      operationStarted = true;
      return operation();
    });
  } catch (error) {
    if (operationStarted) throw error;
    throw new Error(`Pantry snapshot could not be persisted because Web Locks could not coordinate cross-tab pantry mutations: ${String(error)}`);
  }
};

const runPantryWriteInOrder = async <T>(
  scope: SyncScope,
  assertWritable: () => void,
  write: () => Promise<T>,
): Promise<T> => {
  const previous = pantryWriteLocks.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  pantryWriteLocks.set(scope, current);
  await previous;
  try {
    assertWritable();
    return await write();
  } finally {
    release();
    if (pantryWriteLocks.get(scope) === current) pantryWriteLocks.delete(scope);
  }
};

export const setPantryPersistenceSuspended = (suspended: boolean): void => {
  pantryPersistenceSuspended = suspended;
};

export const PANTRY_STORAGE_KEY = 'ikuck-pantry-v1';
export const LEGACY_PANTRY_STORAGE_KEY = 'iricetto-pantry-v1';
export const PANTRY_DATABASE_KEY = 'pantry';
export const PANTRY_CONFLICT_BACKUP_KEY = 'ikuck-pantry-conflict-backup-v1';
const PANTRY_CONFLICT_ARCHIVE_KEY = 'ikuck-pantry-conflict-archive-v1';
const scopedPantryStorageKey = (scope: SyncScope = getActiveDataScope()): string => scope === 'guest'
  ? PANTRY_STORAGE_KEY
  : scopeStorageKey(scope, PANTRY_STORAGE_KEY);
const scopedPantryDatabaseKey = (scope: SyncScope = getActiveDataScope()): string => scope === 'guest'
  ? PANTRY_DATABASE_KEY
  : scopeStorageKey(scope, PANTRY_DATABASE_KEY);

export interface PantrySnapshot {
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  pantryLots?: PantryLot[];
}

interface PersistedPantryState {
  state: PantrySnapshot;
  version: number;
  revision?: number;
  mirrorObsolete?: boolean;
}

export type PantrySnapshotConflictReason = 'unrevisioned-local-write' | 'equal-revision' | 'concurrent-write';

export interface PantrySnapshotConflictCopy {
  id: string;
  label: string;
  revision: number | null;
  snapshot: PantrySnapshot;
}

export interface PantrySnapshotConflictBackup {
  id: string;
  scope: SyncScope;
  reason: PantrySnapshotConflictReason;
  copies: PantrySnapshotConflictCopy[];
  createdAt: string;
  resolvedAt?: string;
  selectedCopyId?: string;
  recoveryPendingCopyId?: string;
}

export type PantrySnapshotConflictArchiveEntry = PantrySnapshotConflictBackup & {
  resolvedAt: string;
  selectedCopyId: string;
};

export class PantrySnapshotConflictError extends Error {
  readonly code = 'pantry_snapshot_conflict';
  readonly copies: PantrySnapshotConflictCopy[];

  constructor(
    readonly scope: SyncScope,
    readonly reason: PantrySnapshotConflictReason,
    readonly indexedDbSnapshot: PantrySnapshot,
    readonly localSnapshot: PantrySnapshot,
    readonly indexedDbRevision: number | null,
    readonly localRevision: number | null,
    copies?: PantrySnapshotConflictCopy[],
  ) {
    super('Pantry snapshots conflict; both copies are preserved and writes are paused pending explicit recovery.');
    this.name = 'PantrySnapshotConflictError';
    this.copies = copies ?? [
      { id: 'indexed-db', label: 'Copia IndexedDB', revision: indexedDbRevision, snapshot: indexedDbSnapshot },
      { id: 'local-storage', label: 'Copia localStorage', revision: localRevision, snapshot: localSnapshot },
    ];
  }
}

export class PantrySnapshotConflictBackupError extends PantrySnapshotConflictError {
  readonly corruptedBackup = true;

  constructor(scope: SyncScope) {
    const emptySnapshot: PantrySnapshot = { pantryItems: [], stapleIds: [] };
    super(scope, 'concurrent-write', emptySnapshot, emptySnapshot, null, null, []);
    this.name = 'PantrySnapshotConflictBackupError';
    this.message = 'The stored pantry conflict backup is malformed and preserved. Pantry reads, writes, sync, and recovery are paused.';
  }
}

interface LocalStoragePantryData {
  raw: string | null;
  snapshot: PantrySnapshot | null;
}

interface LocalStorageSource {
  key: string;
  raw: string;
}

function isParsedIngredient(value: unknown): value is ParsedIngredient {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean';
}

const PANTRY_UNITS: readonly PantryUnit[] = ['g', 'kg', 'ml', 'l', 'piece', 'pack'];

export function isPantryLot(value: unknown): value is PantryLot {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.ingredientId === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean'
    && (candidate.quantity === null || (typeof candidate.quantity === 'number' && Number.isFinite(candidate.quantity) && candidate.quantity > 0))
    && (candidate.unit === null || (typeof candidate.unit === 'string' && PANTRY_UNITS.includes(candidate.unit as PantryUnit)))
    && (candidate.quantity === null ? candidate.unit === null : candidate.unit !== null)
    && (candidate.expiresAt === null || (typeof candidate.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.expiresAt)))
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string';
}

export const createPresencePantryLot = (item: ParsedIngredient, id = item.id, now = new Date().toISOString()): PantryLot => ({
  id,
  ingredientId: item.id,
  label: item.label,
  known: item.known,
  quantity: null,
  unit: null,
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
});

export const derivePantryItems = (lots: readonly PantryLot[]): ParsedIngredient[] => {
  const items = new Map<string, ParsedIngredient>();
  for (const lot of lots) {
    if (!items.has(lot.ingredientId)) {
      items.set(lot.ingredientId, {
        id: lot.ingredientId,
        label: lot.label,
        known: lot.known,
      });
    }
  }
  return [...items.values()];
};

// Legacy item-only snapshots have no lot timestamps; keep their read normalization stable for CAS fingerprints.
const LEGACY_PANTRY_LOT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export const normalizePantrySnapshot = (snapshot: PantrySnapshot): PantrySnapshot => {
  const validLots = (snapshot.pantryLots ?? []).filter(isPantryLot);
  const representedIngredients = new Set(validLots.map((lot) => lot.ingredientId));
  const legacyItems = snapshot.pantryItems.filter(isParsedIngredient);
  const lots = [...validLots];

  for (const item of legacyItems) {
    if (!representedIngredients.has(item.id)) {
      lots.push(createPresencePantryLot(item, item.id, LEGACY_PANTRY_LOT_TIMESTAMP));
      representedIngredients.add(item.id);
    }
  }

  return {
    pantryItems: derivePantryItems(lots),
    stapleIds: [...new Set(snapshot.stapleIds.filter((id) => typeof id === 'string'))],
    pantryLots: lots,
  };
};

const serializeSnapshot = (snapshot: PantrySnapshot, revision?: number): string => JSON.stringify({
  state: normalizePantrySnapshot(snapshot),
  version: 1,
  ...(revision === undefined ? {} : { revision }),
});

const serializeIndexedDbSnapshot = (snapshot: PantrySnapshot, mirrorObsolete: boolean, revision?: number): string => JSON.stringify({
  state: normalizePantrySnapshot(snapshot),
  version: 1,
  ...(revision === undefined ? {} : { revision }),
  mirrorObsolete,
});

const pantryRevisionFromRaw = (raw: string | null): number | null => {
  if (raw === null) return null;
  try {
    const revision = (JSON.parse(raw) as Partial<PersistedPantryState>).revision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  } catch {
    return null;
  }
};

const rememberPantryRevision = (scope: SyncScope, raw: string | null): void => {
  const revision = pantryRevisionFromRaw(raw);
  if (revision !== null) latestPantryRevisions.set(scope, Math.max(latestPantryRevisions.get(scope) ?? 0, revision));
};

const mirrorObsoleteFromIndexedDbSnapshot = (raw: string): boolean | null => {
  try {
    const persisted = JSON.parse(raw) as Partial<PersistedPantryState>;
    return typeof persisted.mirrorObsolete === 'boolean' ? persisted.mirrorObsolete : null;
  } catch {
    return null;
  }
};

function parsePantrySnapshot(raw: string): PantrySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPantryState>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.state !== 'object' || parsed.state === null) {
      return null;
    }

    const state = parsed.state as Partial<PantrySnapshot>;
    if (!Array.isArray(state.pantryItems) || !Array.isArray(state.stapleIds)) {
      return null;
    }

    if (!state.pantryItems.every(isParsedIngredient) || !state.stapleIds.every((id) => typeof id === 'string')) {
      return null;
    }

    return normalizePantrySnapshot({
      pantryItems: state.pantryItems,
      stapleIds: state.stapleIds,
      pantryLots: Array.isArray(state.pantryLots) ? state.pantryLots : undefined,
    });
  } catch {
    return null;
  }
}

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const pantryConflictMarkerKey = (scope: SyncScope): string => `${scopedPantryStorageKey(scope)}-conflict`;
const pantryConflictDatabaseKey = (scope: SyncScope): string => scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
const pantryConflictArchiveDatabaseKey = (scope: SyncScope): string => scopeStorageKey(scope, PANTRY_CONFLICT_ARCHIVE_KEY);

const activatePantryConflict = (error: PantrySnapshotConflictError): void => {
  activePantryConflicts.set(error.scope, error);
  try {
    getLocalStorage()?.setItem(pantryConflictMarkerKey(error.scope), '1');
  } catch {
    // IndexedDB conflict backup remains authoritative when localStorage is unavailable.
  }
};

const deactivatePantryConflict = (scope: SyncScope): boolean => {
  try {
    const storage = getLocalStorage();
    storage?.removeItem(pendingIndexedDbStorageKey(scope));
    storage?.removeItem(pantryConflictMarkerKey(scope));
  } catch {
    return false;
  }
  activePantryConflicts.delete(scope);
  return true;
};

export const isPantrySnapshotConflictActive = (scope: SyncScope = getActiveDataScope()): boolean => {
  if (activePantryConflicts.has(scope)) return true;
  const localBackup = readLocalPantryConflictBackup(scope);
  if (localBackup.malformed) {
    malformedPantryConflictBackupError(scope);
    return true;
  }
  if (localBackup.backup?.resolvedAt === undefined && localBackup.backup !== null) {
    conflictErrorFromBackup(localBackup.backup, false);
    return true;
  }
  try {
    return getLocalStorage()?.getItem(pantryConflictMarkerKey(scope)) === '1';
  } catch {
    // A denied marker read is not evidence of a conflict. Async read/write/sync paths validate persisted backups.
    return false;
  }
};

const isPantryConflictSnapshot = (value: unknown): value is PantrySnapshot => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const hasPantryLots = Object.prototype.hasOwnProperty.call(candidate, 'pantryLots');
  return Array.isArray(candidate.pantryItems)
    && Array.from(candidate.pantryItems).every(isParsedIngredient)
    && Array.isArray(candidate.stapleIds)
    && Array.from(candidate.stapleIds).every((id) => typeof id === 'string')
    && (!hasPantryLots || (Array.isArray(candidate.pantryLots) && Array.from(candidate.pantryLots).every(isPantryLot)));
};

const isPantryConflictBackupShape = (value: unknown): value is PantrySnapshotConflictBackup => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PantrySnapshotConflictBackup>;
  return typeof candidate.id === 'string'
    && (candidate.scope === 'guest' || (typeof candidate.scope === 'string'
      && (candidate.scope.startsWith('account:') || candidate.scope.startsWith('house:'))))
    && (candidate.reason === 'unrevisioned-local-write' || candidate.reason === 'equal-revision'
      || candidate.reason === 'concurrent-write')
    && Array.isArray(candidate.copies)
    && candidate.copies.length > 0
    && candidate.copies.every((copy) => typeof copy === 'object' && copy !== null
      && typeof copy.id === 'string' && typeof copy.label === 'string'
      && (copy.revision === null || typeof copy.revision === 'number')
      && typeof copy.snapshot === 'object' && copy.snapshot !== null)
    && typeof candidate.createdAt === 'string';
};

const isPantryConflictBackup = (value: unknown): value is PantrySnapshotConflictBackup => {
  if (!isPantryConflictBackupShape(value)) return false;
  const candidate = value as PantrySnapshotConflictBackup;
  return Array.from(candidate.copies).every((copy) => typeof copy === 'object' && copy !== null && !Array.isArray(copy)
      && Number.isFinite(copy.revision ?? 0)
      && isPantryConflictSnapshot(copy.snapshot))
    && (candidate.resolvedAt === undefined || typeof candidate.resolvedAt === 'string')
    && (candidate.selectedCopyId === undefined || typeof candidate.selectedCopyId === 'string')
    && (candidate.recoveryPendingCopyId === undefined || typeof candidate.recoveryPendingCopyId === 'string');
};

const malformedPantryConflictBackupError = (scope: SyncScope): PantrySnapshotConflictBackupError => {
  const existing = activePantryConflicts.get(scope);
  if (existing instanceof PantrySnapshotConflictBackupError) return existing;
  const error = new PantrySnapshotConflictBackupError(scope);
  activePantryConflicts.set(scope, error);
  return error;
};

const uniqueConflictCopyIds = (
  copies: PantrySnapshotConflictCopy[],
  initialDuplicateSuffix: (index: number, duplicateOrdinal: number) => number = (index) => index + 1,
  formatDuplicateId: (copy: PantrySnapshotConflictCopy, suffix: number) => string = (copy, suffix) => `${copy.id}-${suffix}`,
): PantrySnapshotConflictCopy[] => {
  const reservedIds = new Set(copies.map((copy) => copy.id));
  const assignedIds = new Set<string>();
  const duplicateOrdinals = new Map<string, number>();
  return copies.map((copy, index) => {
    const duplicateOrdinal = (duplicateOrdinals.get(copy.id) ?? 0) + 1;
    duplicateOrdinals.set(copy.id, duplicateOrdinal);
    let id = copy.id;
    if (assignedIds.has(id)) {
      let suffix = initialDuplicateSuffix(index, duplicateOrdinal);
      do {
        id = formatDuplicateId(copy, suffix);
        suffix += 1;
      } while (assignedIds.has(id) || reservedIds.has(id));
    }
    assignedIds.add(id);
    return id === copy.id ? copy : { ...copy, id };
  });
};

const hasAmbiguousConflictCopyReference = (
  copies: PantrySnapshotConflictCopy[],
  copyId: string | undefined,
): boolean => {
  if (copyId === undefined) return false;
  const snapshotSignatures = new Set<string>();
  for (const copy of copies) {
    if (copy.id !== copyId) continue;
    snapshotSignatures.add(JSON.stringify(copy.snapshot));
    if (snapshotSignatures.size > 1) return true;
  }
  return false;
};

const validatedPantryConflictBackup = (
  value: unknown,
  scope: SyncScope,
): PantrySnapshotConflictBackup | null => {
  if (value === null) return null;
  if (!isPantryConflictBackup(value) || value.scope !== scope) throw malformedPantryConflictBackupError(scope);
  if (hasAmbiguousConflictCopyReference(value.copies, value.selectedCopyId)
    || hasAmbiguousConflictCopyReference(value.copies, value.recoveryPendingCopyId)) {
    throw malformedPantryConflictBackupError(scope);
  }
  return { ...value, copies: uniqueConflictCopyIds(value.copies) };
};

const conflictErrorFromBackup = (
  backup: PantrySnapshotConflictBackup,
  persistMarker = true,
): PantrySnapshotConflictError => {
  const copies = uniqueConflictCopyIds(backup.copies);
  const first = copies[0];
  const second = copies[1] ?? first;
  const error = new PantrySnapshotConflictError(
    backup.scope,
    backup.reason,
    first?.snapshot ?? { pantryItems: [], stapleIds: [] },
    second?.snapshot ?? { pantryItems: [], stapleIds: [] },
    first?.revision ?? null,
    second?.revision ?? null,
    copies,
  );
  if (persistMarker) activatePantryConflict(error);
  else activePantryConflicts.set(error.scope, error);
  return error;
};

const uniqueConflictCopies = (
  primary: PantrySnapshotConflictCopy[],
  secondary: PantrySnapshotConflictCopy[],
): PantrySnapshotConflictCopy[] => {
  const signatures = new Set<string>();
  const distinctCopies: PantrySnapshotConflictCopy[] = [];
  for (const copy of [...primary, ...secondary]) {
    const signature = serializeSnapshot(copy.snapshot);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    distinctCopies.push(copy);
  }
  return uniqueConflictCopyIds(distinctCopies);
};

const createConflictBackup = (
  scope: SyncScope,
  reason: PantrySnapshotConflictReason,
  copies: PantrySnapshotConflictCopy[],
  previous: unknown | null,
): PantrySnapshotConflictBackup => {
  const previousBackup = validatedPantryConflictBackup(previous, scope);
  const activePreviousBackup = previousBackup !== null && previousBackup.resolvedAt === undefined
    ? previousBackup
    : null;
  const mergedCopies = activePreviousBackup === null
    ? uniqueConflictCopies([], copies)
    : uniqueConflictCopies(activePreviousBackup.copies, copies);
  const backup: PantrySnapshotConflictBackup = activePreviousBackup === null
    ? {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      scope,
      reason,
      copies: mergedCopies,
      createdAt: new Date().toISOString(),
    }
    : { ...activePreviousBackup, copies: mergedCopies };
  const first = mergedCopies[0];
  const second = mergedCopies[1] ?? first;
  activatePantryConflict(new PantrySnapshotConflictError(
    scope,
    backup.reason,
    first?.snapshot ?? { pantryItems: [], stapleIds: [] },
    second?.snapshot ?? { pantryItems: [], stapleIds: [] },
    first?.revision ?? null,
    second?.revision ?? null,
    mergedCopies,
  ));
  return backup;
};

const backupFromConflictError = (error: PantrySnapshotConflictError): PantrySnapshotConflictBackup => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  scope: error.scope,
  reason: error.reason,
  copies: uniqueConflictCopyIds(error.copies),
  createdAt: new Date().toISOString(),
});

interface LocalPantryConflictBackup {
  raw: string | null;
  backup: PantrySnapshotConflictBackup | null;
  malformed: boolean;
}

const readLocalPantryConflictBackup = (scope: SyncScope): LocalPantryConflictBackup => {
  const storage = getLocalStorage();
  if (storage === null) return { raw: null, backup: null, malformed: false };
  let raw: string | null;
  try {
    raw = storage.getItem(pantryConflictDatabaseKey(scope));
  } catch {
    return { raw: null, backup: null, malformed: false };
  }
  if (raw === null) return { raw: null, backup: null, malformed: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isPantryConflictBackup(parsed) && parsed.scope === scope) {
      const backup = validatedPantryConflictBackup(parsed, scope);
      if (backup !== null) return { raw, backup, malformed: false };
    }
    return { raw, backup: null, malformed: true };
  } catch {
    return { raw, backup: null, malformed: true };
  }
};

const normalizedPantryConflictBackup = (backup: PantrySnapshotConflictBackup): PantrySnapshotConflictBackup => ({
  ...backup,
  copies: uniqueConflictCopyIds(backup.copies).map((copy) => {
    const snapshot = normalizePantrySnapshot(copy.snapshot);
    if (!Array.isArray(copy.snapshot.pantryLots)) {
      snapshot.pantryLots = snapshot.pantryLots?.map((lot) => ({
        ...lot,
        createdAt: backup.createdAt,
        updatedAt: backup.createdAt,
      }));
    }
    return { ...copy, snapshot };
  }),
});

const recoverablePantryConflictBackup = (backup: PantrySnapshotConflictBackup): PantrySnapshotConflictBackup => ({
  ...backup,
  resolvedAt: undefined,
  selectedCopyId: undefined,
  recoveryPendingCopyId: undefined,
});

const mergePantryConflictBackups = (
  primary: PantrySnapshotConflictBackup,
  additional: PantrySnapshotConflictBackup,
): PantrySnapshotConflictBackup => ({
  ...primary,
  copies: uniqueConflictCopies(primary.copies, additional.copies),
});

export async function readPantryConflictBackup(
  scope: SyncScope = getActiveDataScope(),
): Promise<PantrySnapshotConflictBackup | null> {
  let indexedBackup: PantrySnapshotConflictBackup | null = null;
  let resolvedBackup: PantrySnapshotConflictBackup | null = null;
  if (isIndexedDbAvailable()) {
    try {
      const stored = await readKeyValue<unknown>(pantryConflictDatabaseKey(scope));
      const storedBackup = validatedPantryConflictBackup(stored, scope);
      if (storedBackup !== null) {
        if (storedBackup.resolvedAt === undefined) indexedBackup = storedBackup;
        else resolvedBackup = storedBackup;
      }
    } catch (error) {
      if (error instanceof PantrySnapshotConflictError) throw error;
      // Keep an in-memory or cross-tab marker fail-closed when IndexedDB is unavailable.
    }
  }

  const localSource = readLocalPantryConflictBackup(scope);
  if (localSource.malformed) throw malformedPantryConflictBackupError(scope);
  const localBackup = localSource.backup;
  const localActiveBackup = localBackup?.resolvedAt === undefined ? localBackup : null;
  if (indexedBackup !== null) {
    const visibleBackup = localActiveBackup === null
      ? indexedBackup
      : mergePantryConflictBackups(indexedBackup, localActiveBackup);
    return normalizedPantryConflictBackup(visibleBackup);
  }

  if (resolvedBackup === null && localBackup?.resolvedAt !== undefined) resolvedBackup = localBackup;
  let markerIsSet: boolean | null = false;
  try {
    markerIsSet = getLocalStorage()?.getItem(pantryConflictMarkerKey(scope)) === '1';
  } catch {
    markerIsSet = null;
  }
  if (resolvedBackup !== null) {
    if (markerIsSet !== true && localActiveBackup === null) {
      const inMemoryConflict = activePantryConflicts.get(scope);
      if (markerIsSet === false || inMemoryConflict === undefined) {
        activePantryConflicts.delete(scope);
        return null;
      }
    }
    if (localActiveBackup !== null && localActiveBackup.id !== resolvedBackup.id) {
      conflictErrorFromBackup(localActiveBackup, false);
      return normalizedPantryConflictBackup(localActiveBackup);
    }
    let recoverable = recoverablePantryConflictBackup(resolvedBackup);
    if (localActiveBackup !== null) recoverable = mergePantryConflictBackups(recoverable, localActiveBackup);
    conflictErrorFromBackup(recoverable);
    return normalizedPantryConflictBackup(recoverable);
  }
  if (localActiveBackup !== null) return normalizedPantryConflictBackup(localActiveBackup);
  if (markerIsSet === false) {
    activePantryConflicts.delete(scope);
    return null;
  }
  const error = activePantryConflicts.get(scope);
  if (error instanceof PantrySnapshotConflictBackupError) throw error;
  return error === undefined ? null : backupFromConflictError(error);
}

const persistPantryConflictBackupToIndexedDb = async (
  scope: SyncScope,
  backup: PantrySnapshotConflictBackup,
  assertWritable: () => void,
): Promise<PantrySnapshotConflictBackup> => {
  const key = pantryConflictDatabaseKey(scope);
  const localSource = readLocalPantryConflictBackup(scope);
  if (localSource.malformed) throw malformedPantryConflictBackupError(scope);
  const stored = await updateKeyValue<unknown>(key, (existing) => {
    assertWritable();
    const existingBackup = validatedPantryConflictBackup(existing, scope);
    const distinctResolvedHistory = existingBackup !== null
      && existingBackup.resolvedAt !== undefined
      && localSource.backup !== null
      && localSource.backup.resolvedAt === undefined
      && existingBackup.id !== localSource.backup.id
      && backup.id === localSource.backup.id;
    const primaryBackup = distinctResolvedHistory
      ? localSource.backup ?? backup
      : existingBackup ?? localSource.backup ?? backup;
    let activeBackup = primaryBackup.resolvedAt === undefined
      ? primaryBackup
      : recoverablePantryConflictBackup(primaryBackup);
    if (existingBackup !== null && localSource.backup !== null && !distinctResolvedHistory) {
      activeBackup = mergePantryConflictBackups(
        activeBackup,
        recoverablePantryConflictBackup(localSource.backup),
      );
    }
    return activeBackup;
  }, assertWritable);

  if (!isPantryConflictBackup(stored) || stored.scope !== scope || stored.resolvedAt !== undefined) {
    throw new Error('Pantry conflict backup could not be restored');
  }
  conflictErrorFromBackup(stored);

  if (localSource.raw !== null) {
    let sourceChanged = false;
    try {
      const storage = getLocalStorage();
      const currentRaw = storage?.getItem(key) ?? null;
      if (currentRaw === localSource.raw) storage?.removeItem(key);
      else if (currentRaw !== null) sourceChanged = true;
    } catch {
      // The IndexedDB transaction committed the source; keep localStorage if cleanup is denied.
    }
    if (sourceChanged) throw new Error('Pantry conflict backup changed during recovery; retry to preserve all copies');
  }
  return stored;
};

export async function getPantrySnapshotConflictError(
  scope: SyncScope = getActiveDataScope(),
): Promise<PantrySnapshotConflictError | null> {
  let backup: PantrySnapshotConflictBackup | null;
  try {
    backup = await readPantryConflictBackup(scope);
  } catch (error) {
    if (error instanceof PantrySnapshotConflictError) return error;
    throw error;
  }
  if (backup !== null) {
    let markerIsSet = false;
    try {
      markerIsSet = getLocalStorage()?.getItem(pantryConflictMarkerKey(scope)) === '1';
    } catch {
      markerIsSet = true;
    }
    const localBackup = readLocalPantryConflictBackup(scope).backup;
    const backedByActiveLocalCopy = !markerIsSet
      && localBackup !== null
      && localBackup.resolvedAt === undefined
      && localBackup.id === backup.id;
    return conflictErrorFromBackup(backup, !backedByActiveLocalCopy);
  }
  return activePantryConflicts.get(scope) ?? null;
}

const stablePantryArchiveSignature = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stablePantryArchiveSignature).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => (
      `${JSON.stringify(key)}:${stablePantryArchiveSignature(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

type PantryConflictArchiveHeader = {
  id: string;
  scope: SyncScope;
  reason: PantrySnapshotConflictReason;
  createdAt: string;
  resolvedAt: string;
  selectedCopyId: string;
  copies: unknown[];
};

const isPantryConflictArchiveHeader = (value: unknown): value is PantryConflictArchiveHeader => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const validScope = candidate.scope === 'guest' || (typeof candidate.scope === 'string'
    && (candidate.scope.startsWith('account:') || candidate.scope.startsWith('house:')));
  const validReason = candidate.reason === 'unrevisioned-local-write' || candidate.reason === 'equal-revision'
    || candidate.reason === 'concurrent-write';
  return typeof candidate.id === 'string'
    && validScope
    && validReason
    && typeof candidate.createdAt === 'string'
    && typeof candidate.resolvedAt === 'string'
    && typeof candidate.selectedCopyId === 'string'
    && Array.isArray(candidate.copies);
};

const isPantryConflictArchiveCopy = (value: unknown): value is PantrySnapshotConflictCopy => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && (candidate.revision === null || (typeof candidate.revision === 'number' && Number.isFinite(candidate.revision)))
    && typeof candidate.snapshot === 'object'
    && candidate.snapshot !== null
    && !Array.isArray(candidate.snapshot);
};

const normalizePantryArchiveSnapshot = (value: unknown): PantrySnapshot | null => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const pantryItems = candidate.pantryItems;
    const stapleIds = candidate.stapleIds;
    const hasPantryLots = Object.prototype.hasOwnProperty.call(candidate, 'pantryLots');
    const pantryLots = candidate.pantryLots;
    if (!Array.isArray(pantryItems) || !Array.isArray(stapleIds)
      || !Array.from(pantryItems).every(isParsedIngredient)
      || !Array.from(stapleIds).every((id) => typeof id === 'string')
      || (hasPantryLots && (!Array.isArray(pantryLots) || !Array.from(pantryLots).every(isPantryLot)))) return null;
    return normalizePantrySnapshot({
      pantryItems: pantryItems as ParsedIngredient[],
      stapleIds: stapleIds as string[],
      pantryLots: hasPantryLots ? pantryLots as PantryLot[] : undefined,
    });
  } catch {
    return null;
  }
};

const pantryArchiveCopyShape = (
  copy: PantrySnapshotConflictCopy,
  originalSnapshot: unknown = copy.snapshot,
): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {
    pantryItems: copy.snapshot.pantryItems.map(({ id, label, known }) => ({ id, label, known })),
    stapleIds: [...copy.snapshot.stapleIds],
  };
  if (typeof originalSnapshot === 'object' && originalSnapshot !== null && !Array.isArray(originalSnapshot)) {
    const sourceSnapshot = originalSnapshot as Record<string, unknown>;
    if (Array.isArray(sourceSnapshot.pantryLots)) {
      snapshot.pantryLots = Array.from(sourceSnapshot.pantryLots).filter(isPantryLot).map((lot) => ({
        id: lot.id,
        ingredientId: lot.ingredientId,
        label: lot.label,
        known: lot.known,
        quantity: lot.quantity,
        unit: lot.unit,
        expiresAt: lot.expiresAt,
        createdAt: lot.createdAt,
        updatedAt: lot.updatedAt,
      }));
    }
  }
  return {
    id: copy.id,
    label: copy.label,
    revision: copy.revision,
    snapshot,
  };
};

const pantryArchiveEntrySignature = (
  entry: PantrySnapshotConflictArchiveEntry,
  copyShapes: readonly Record<string, unknown>[],
): string => (
  stablePantryArchiveSignature({
    id: entry.id,
    scope: entry.scope,
    reason: entry.reason,
    createdAt: entry.createdAt,
    resolvedAt: entry.resolvedAt,
    selectedCopyId: entry.selectedCopyId,
    copies: copyShapes,
  })
);

export async function readPantryConflictArchive(
  scope: SyncScope = getActiveDataScope(),
): Promise<PantrySnapshotConflictArchiveEntry[]> {
  let indexedDbStored: unknown = null;
  if (isIndexedDbAvailable()) {
    try {
      indexedDbStored = await readKeyValue<unknown>(pantryConflictArchiveDatabaseKey(scope));
    } catch {
      // Keep the local copy available if IndexedDB is temporarily unreadable.
    }
  }

  let localStored: unknown = null;
  try {
    const raw = getLocalStorage()?.getItem(pantryConflictArchiveDatabaseKey(scope));
    localStored = raw === null || raw === undefined ? null : JSON.parse(raw) as unknown;
  } catch {
    // A malformed or inaccessible mirror must not hide a valid IndexedDB archive.
  }

  const result: PantrySnapshotConflictArchiveEntry[] = [];
  const archiveSignatures = new Map<string, Set<string>>();
  const appendArchive = (stored: unknown, source: 'indexed-db' | 'local-storage'): void => {
    let candidates: unknown[];
    try {
      if (Array.isArray(stored)) candidates = stored;
      else if (typeof stored === 'object' && stored !== null && Array.isArray((stored as { entries?: unknown }).entries)) {
        candidates = (stored as { entries: unknown[] }).entries;
      } else {
        return;
      }
    } catch {
      return;
    }

    for (const candidate of candidates) {
      try {
        if (!isPantryConflictArchiveHeader(candidate) || candidate.scope !== scope) continue;

        const copies: PantrySnapshotConflictCopy[] = [];
        const copyShapes: Record<string, unknown>[] = [];
        const copySignatures = new Map<string, Set<string>>();
        for (const value of candidate.copies) {
          try {
            if (!isPantryConflictArchiveCopy(value)) continue;
            const snapshot = normalizePantryArchiveSnapshot(value.snapshot);
            if (snapshot === null) continue;
            const normalizedCopy: PantrySnapshotConflictCopy = { ...value, snapshot };
            const signatureShape = pantryArchiveCopyShape(normalizedCopy, value.snapshot);
            const signature = stablePantryArchiveSignature(signatureShape);
            const signaturesForId = copySignatures.get(normalizedCopy.id) ?? new Set<string>();
            if (signaturesForId.has(signature)) continue;
            signaturesForId.add(signature);
            copySignatures.set(normalizedCopy.id, signaturesForId);
            copyShapes.push(signatureShape);
            copies.push(normalizedCopy);
          } catch {
            // One malformed copy must not hide other copies from this archive entry.
          }
        }
        if (copies.length === 0 || hasAmbiguousConflictCopyReference(copies, candidate.selectedCopyId)) continue;
        const uniquelyIdentifiedCopies = uniqueConflictCopyIds(
          copies,
          (_index, duplicateOrdinal) => duplicateOrdinal,
          (copy, suffix) => `${copy.id}-duplicate-${suffix}`,
        );

        const entry: PantrySnapshotConflictArchiveEntry = {
          id: candidate.id,
          scope: candidate.scope,
          reason: candidate.reason,
          createdAt: candidate.createdAt,
          resolvedAt: candidate.resolvedAt,
          selectedCopyId: uniquelyIdentifiedCopies.find((copy) => copy.id === candidate.selectedCopyId)?.id
            ?? uniquelyIdentifiedCopies[0]!.id,
          copies: uniquelyIdentifiedCopies,
        };
        const signature = pantryArchiveEntrySignature(entry, copyShapes);
        const signaturesForId = archiveSignatures.get(entry.id) ?? new Set<string>();
        if (signaturesForId.has(signature)) continue;
        signaturesForId.add(signature);
        archiveSignatures.set(entry.id, signaturesForId);

        const sameId = result.filter((existing) => existing.id === entry.id);
        let distinctEntry = entry;
        if (sameId.length > 0) {
          let suffix = 1;
          let entryId = `${entry.id}-${source}`;
          while (result.some((existing) => existing.id === entryId)) {
            suffix += 1;
            entryId = `${entry.id}-${source}-${suffix}`;
          }
          distinctEntry = { ...entry, id: entryId };
        }
        result.push(distinctEntry);
      } catch {
        // A malformed archive entry must not abort the rest of this source or the union.
      }
    }
  };

  appendArchive(indexedDbStored, 'indexed-db');
  appendArchive(localStored, 'local-storage');
  return result;
}

export async function reopenPantryArchivedConflict(
  scope: SyncScope,
  archiveId: string,
): Promise<PantrySnapshotConflictBackup> {
  return trackScopedWrite(scope, async (assertWritable) => runPantryWriteInOrder(scope, assertWritable, () => (
    withLocalPantryWriteLock(scope, async () => {
      await throwIfPantryConflictActive(scope);
    const archived = (await readPantryConflictArchive(scope)).find((entry) => entry.id === archiveId);
    if (archived === undefined) throw new Error('The archived pantry copies are unavailable');
    const currentSnapshot = normalizePantrySnapshot(await readPantrySnapshotInternal(scope, true) ?? { pantryItems: [], stapleIds: [] });
    const archivedCopies = archived.copies.map((copy) => ({
      ...copy,
      snapshot: normalizePantrySnapshot(copy.snapshot),
    }));
    let currentCopyId = `current-${archived.id}`;
    while (archivedCopies.some((copy) => copy.id === currentCopyId)) currentCopyId = `${currentCopyId}-current`;
    const currentCopy: PantrySnapshotConflictCopy = {
      id: currentCopyId,
      label: 'Dispensa attuale prima del ripristino',
      revision: null,
      snapshot: currentSnapshot,
    };
    const copies = [...archivedCopies, currentCopy];
    const selectedCopy = archivedCopies.find((copy) => copy.id === archived.selectedCopyId) ?? archivedCopies[0];
    const conflict = new PantrySnapshotConflictError(
      scope,
      'concurrent-write',
      currentSnapshot,
      selectedCopy?.snapshot ?? currentSnapshot,
      null,
      selectedCopy?.revision ?? null,
      copies,
    );
    activatePantryConflict(conflict);
    assertWritable();
    await persistConflictErrorIfNeeded(conflict, assertWritable, true);
    const activeBackup = await readPantryConflictBackup(scope);
    if (activeBackup === null) throw new Error('The archived pantry copies could not be reopened');
      return activeBackup;
    })
  )));
}

const throwIfPantryConflictActive = async (scope: SyncScope): Promise<void> => {
  const error = await getPantrySnapshotConflictError(scope);
  if (error !== null) throw error;
  if (isPantrySnapshotConflictActive(scope)) {
    throw new PantrySnapshotConflictError(scope, 'concurrent-write', { pantryItems: [], stapleIds: [] },
      { pantryItems: [], stapleIds: [] }, null, null, []);
  }
};

const persistConflictErrorIfNeeded = async (
  error: PantrySnapshotConflictError,
  assertWritable?: () => void,
  pantryWriteLockHeld = false,
): Promise<void> => {
  if (isIndexedDbAvailable()) {
    await updateKeyValue<unknown>(
      pantryConflictDatabaseKey(error.scope),
      (existing) => {
        const existingBackup = validatedPantryConflictBackup(existing, error.scope);
        return existingBackup !== null && existingBackup.resolvedAt === undefined
          ? createConflictBackup(error.scope, error.reason, error.copies, existingBackup)
          : backupFromConflictError(error);
      },
      assertWritable,
    );
    return;
  }

  const persistLocalBackup = async (): Promise<void> => {
    try {
      const key = pantryConflictDatabaseKey(error.scope);
      const storage = getLocalStorage();
      if (storage === null) return;
      const existingRaw = storage.getItem(key);
      let existing: unknown = null;
      if (existingRaw !== null) {
        try {
          existing = JSON.parse(existingRaw) as unknown;
        } catch {
          throw malformedPantryConflictBackupError(error.scope);
        }
        if (validatedPantryConflictBackup(existing, error.scope) === null) {
          throw malformedPantryConflictBackupError(error.scope);
        }
      }
      const backup = createConflictBackup(error.scope, error.reason, error.copies, existing);
      assertWritable?.();
      storage.setItem(key, JSON.stringify(backup));
    } catch (persistError) {
      if (persistError instanceof PantrySnapshotConflictBackupError) throw persistError;
      // Both canonical browser copies remain intact; a later read can rebuild this backup.
    }
  };
  if (pantryWriteLockHeld) {
    await persistLocalBackup();
    return;
  }
  try {
    await withLocalPantryWriteLock(error.scope, persistLocalBackup);
  } catch (persistError) {
    if (persistError instanceof PantrySnapshotConflictBackupError) throw persistError;
    // Keep both canonical copies untouched when cross-tab backup coordination is unavailable.
  }
};

function readLocalStorageSource(): LocalStorageSource | null {
  const storage = getLocalStorage();
  if (storage === null) return null;
  const candidates = [PANTRY_STORAGE_KEY, LEGACY_PANTRY_STORAGE_KEY];

  for (const key of candidates) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return null;
    }
    if (raw === null) continue;

    if (parsePantrySnapshot(raw) !== null) {
      return { key, raw };
    }

    try {
      storage.removeItem(key);
    } catch {
      // Keep the IndexedDB snapshot authoritative if the mirror cannot be cleaned up.
    }
  }

  return null;
}

const readLocalStorageData = (scope: SyncScope = getActiveDataScope()): LocalStoragePantryData => {
  const storage = getLocalStorage();
  if (storage === null) return { raw: null, snapshot: null };
  let raw: string | null;
  try {
    raw = storage.getItem(scopedPantryStorageKey(scope));
  } catch {
    return { raw: null, snapshot: null };
  }
  if (raw === null) return { raw: null, snapshot: null };

  const snapshot = parsePantrySnapshot(raw);
  if (snapshot === null) {
    try {
      storage.removeItem(scopedPantryStorageKey(scope));
    } catch {
      // Invalid mirrors must not prevent reading IndexedDB.
    }
  }
  return { raw, snapshot };
};

const nextPantryRevision = (scope: SyncScope, indexedDbRaw: string | null = null): number => {
  const localRevision = pantryRevisionFromRaw(readLocalStorageData(scope).raw);
  const indexedRevision = pantryRevisionFromRaw(indexedDbRaw);
  const revision = Math.max(
    Date.now(),
    (latestPantryRevisions.get(scope) ?? 0) + 1,
    (localRevision ?? 0) + 1,
    (indexedRevision ?? 0) + 1,
  );
  latestPantryRevisions.set(scope, revision);
  return revision;
};

const nextPantryRevisionAfterStoredRead = async (
  scope: SyncScope,
  assertWritable: () => void,
): Promise<{ revision: number; indexedDbRaw: string | null }> => {
  let indexedDbRaw: string | null = null;
  if (isIndexedDbAvailable()) {
    try {
      indexedDbRaw = await readKeyValue<string>(scopedPantryDatabaseKey(scope));
    } catch {
      // A local mirror write can still proceed when IndexedDB cannot be read.
    }
  }
  assertWritable();
  rememberPantryRevision(scope, indexedDbRaw);
  return { revision: nextPantryRevision(scope, indexedDbRaw), indexedDbRaw };
};

const hasPendingIndexedDbWrite = (scope: SyncScope): boolean => {
  try {
    return getLocalStorage()?.getItem(pendingIndexedDbStorageKey(scope)) === '1';
  } catch {
    return false;
  }
};

const hasObsoleteLocalMirror = async (
  scope: SyncScope,
  indexedDbRaw: string,
  assertWritable?: () => void,
): Promise<boolean> => {
  const embeddedFreshness = mirrorObsoleteFromIndexedDbSnapshot(indexedDbRaw);
  if (embeddedFreshness !== null) return embeddedFreshness;
  try {
    const obsolete = await readKeyValue<boolean>(obsoleteMirrorDatabaseKey(scope));
    assertWritable?.();
    return obsolete === true;
  } catch {
    assertWritable?.();
    return false;
  }
};

const pantrySnapshotFingerprint = (snapshot: PantrySnapshot): string => {
  const normalized = normalizePantrySnapshot(snapshot);
  return JSON.stringify({
    pantryItems: [...normalized.pantryItems].sort((left, right) => left.id.localeCompare(right.id)),
    pantryLots: [...(normalized.pantryLots ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    stapleIds: [...normalized.stapleIds].sort(),
  });
};

const pantrySnapshotContentSignature = (raw: string, snapshot: PantrySnapshot): string | null => {
  try {
    const persisted = JSON.parse(raw) as Partial<PersistedPantryState>;
    const persistedLots = Array.isArray(persisted.state?.pantryLots)
      ? persisted.state.pantryLots.filter(isPantryLot)
      : [];
    return JSON.stringify({
      pantryItems: [...snapshot.pantryItems].sort((left, right) => left.id.localeCompare(right.id)),
      stapleIds: [...snapshot.stapleIds].sort(),
      pantryLots: persistedLots.sort((left, right) => left.id.localeCompare(right.id)),
    });
  } catch {
    return null;
  }
};

const pantrySnapshotsDiffer = (
  leftRaw: string | null,
  leftSnapshot: PantrySnapshot,
  rightRaw: string | null,
  rightSnapshot: PantrySnapshot,
): boolean => {
  const leftSignature = leftRaw === null ? null : pantrySnapshotContentSignature(leftRaw, leftSnapshot);
  const rightSignature = rightRaw === null ? null : pantrySnapshotContentSignature(rightRaw, rightSnapshot);
  if (leftSignature === null || rightSignature === null) {
    return serializeSnapshot(leftSnapshot) !== serializeSnapshot(rightSnapshot);
  }
  return leftSignature !== rightSignature;
};

const pantrySnapshotConflict = (
  scope: SyncScope,
  indexedDbRaw: string | null,
  indexedSnapshot: PantrySnapshot | null,
  localRaw: string | null,
  localSnapshot: PantrySnapshot | null,
  mirrorIsObsolete: boolean,
): PantrySnapshotConflictError | null => {
  if (indexedDbRaw === null || indexedSnapshot === null || localRaw === null || localSnapshot === null
    || !pantrySnapshotsDiffer(indexedDbRaw, indexedSnapshot, localRaw, localSnapshot)) return null;

  const indexedRevision = pantryRevisionFromRaw(indexedDbRaw);
  const localRevision = pantryRevisionFromRaw(localRaw);
  const knownLocalMirrorIsObsolete = knownObsoleteLocalMirrors.has(scope)
    && knownObsoleteLocalMirrors.get(scope) === localRaw;
  if (knownObsoleteLocalMirrors.has(scope) && !knownLocalMirrorIsObsolete) knownObsoleteLocalMirrors.delete(scope);
  if (indexedRevision !== null && indexedRevision === localRevision) {
    const conflict = new PantrySnapshotConflictError(
      scope, 'equal-revision', indexedSnapshot, localSnapshot, indexedRevision, localRevision,
    );
    activatePantryConflict(conflict);
    return conflict;
  }
  if (indexedRevision !== null && localRevision === null && mirrorIsObsolete && !knownLocalMirrorIsObsolete) {
    // A missing pending marker cannot prove that an unrevisioned mirror is stale: the write
    // may have committed before the marker was set or after the marker was cleared. Only an
    // exact same-tab mirror captured before a failed mirror update is known to be obsolete.
    const conflict = new PantrySnapshotConflictError(
      scope, 'unrevisioned-local-write', indexedSnapshot, localSnapshot, indexedRevision, localRevision,
    );
    activatePantryConflict(conflict);
    return conflict;
  }
  return null;
};

const assertPantrySnapshotsUnambiguous = async (
  scope: SyncScope,
  indexedDbRaw: string | null,
  assertWritable?: () => void,
): Promise<void> => {
  if (indexedDbRaw === null) return;
  const indexedSnapshot = parsePantrySnapshot(indexedDbRaw);
  if (indexedSnapshot === null) return;
  const localData = readLocalStorageData(scope);
  if (localData.snapshot === null) return;
  const mirrorIsObsolete = await hasObsoleteLocalMirror(scope, indexedDbRaw, assertWritable);
  assertWritable?.();
  const conflict = pantrySnapshotConflict(
    scope, indexedDbRaw, indexedSnapshot, localData.raw, localData.snapshot, mirrorIsObsolete,
  );
  if (conflict !== null) {
    await persistConflictErrorIfNeeded(conflict);
    throw conflict;
  }
};

const selectPantrySnapshot = async (
  scope: SyncScope,
  indexedDbRaw: string | null,
  indexedSnapshot: PantrySnapshot | null,
  localRaw: string | null,
  localSnapshot: PantrySnapshot | null,
  mirrorIsObsolete: boolean,
): Promise<PantrySnapshot | null> => {
  const conflict = pantrySnapshotConflict(
    scope, indexedDbRaw, indexedSnapshot, localRaw, localSnapshot, mirrorIsObsolete,
  );
  if (conflict !== null) {
    await persistConflictErrorIfNeeded(conflict);
    throw conflict;
  }

  const indexedRevision = pantryRevisionFromRaw(indexedDbRaw);
  const localRevision = pantryRevisionFromRaw(localRaw);
  rememberPantryRevision(scope, indexedDbRaw);

  if (localSnapshot !== null && localRevision !== null
    && (indexedSnapshot === null || indexedRevision === null || localRevision > indexedRevision)) {
    return localSnapshot;
  }
  if (indexedSnapshot !== null && indexedRevision !== null
    && (localSnapshot === null || (localRevision !== null && indexedRevision > localRevision)
      || (localRevision === null && mirrorIsObsolete))) {
    return indexedSnapshot;
  }
  if (hasPendingIndexedDbWrite(scope) && localSnapshot !== null && !mirrorIsObsolete) return localSnapshot;
  if (!mirrorIsObsolete && indexedSnapshot !== null && localSnapshot !== null
    && pantrySnapshotsDiffer(indexedDbRaw, indexedSnapshot, localRaw, localSnapshot)) {
    // Unversioned legacy clients could leave their latest edit only in the local mirror.
    return localSnapshot;
  }
  return indexedSnapshot ?? localSnapshot;
};

const recordLocalMirrorFreshness = async (
  scope: SyncScope,
  mirrorWritten: boolean,
  assertWritable: () => void,
): Promise<void> => {
  try {
    assertWritable();
    if (mirrorWritten) await deleteKeyValue(obsoleteMirrorDatabaseKey(scope), assertWritable);
    else await writeKeyValue(obsoleteMirrorDatabaseKey(scope), true, assertWritable);
    assertWritable();
  } catch {
    assertWritable();
    // The freshness marker is best-effort; the primary pantry write remains successful.
  }
};

const setPendingIndexedDbWrite = (
  scope: SyncScope,
  pending: boolean,
  assertWritable: () => void,
): void => {
  assertWritable();
  try {
    const storage = getLocalStorage();
    if (storage === null) return;
    if (pending) storage.setItem(pendingIndexedDbStorageKey(scope), '1');
    else storage.removeItem(pendingIndexedDbStorageKey(scope));
  } catch {
    // The marker is best-effort; IndexedDB remains the normal durable store.
  }
};

const writeLocalStorageSnapshot = (
  serialized: string,
  scope: SyncScope,
  assertWritable: () => void,
): boolean => {
  assertWritable();
  try {
    const storage = getLocalStorage();
    if (storage === null) return false;
    storage.setItem(scopedPantryStorageKey(scope), serialized);
    return true;
  } catch {
    return false;
  }
};

const persistLocalStorageSnapshotWithCrossTabCheck = async (
  snapshot: PantrySnapshot,
  scope: SyncScope,
  expectedRaw: string | null,
  assertWritable: () => void,
  onStored?: () => void,
  writeRevision?: number,
  observedAfterWrite?: string | null,
  onMirrorUnavailable?: () => Promise<void> | void,
): Promise<boolean> => {
  return withLocalPantryWriteLock(scope, async () => {
    assertWritable();
    const localData = readLocalStorageData(scope);
    if (expectedRaw !== localData.raw) {
      if (localData.snapshot === null) {
        throw new Error('The local pantry changed outside this tab and cannot be compared safely');
      }
      const revision = writeRevision ?? nextPantryRevision(scope);
      const localRevision = pantryRevisionFromRaw(localData.raw);
      const conflict = new PantrySnapshotConflictError(
        scope,
        'concurrent-write',
        localData.snapshot,
        snapshot,
        localRevision,
        revision,
        [
          { id: 'local-storage', label: 'Copia localStorage', revision: localRevision, snapshot: localData.snapshot },
          { id: 'concurrent-write', label: 'Modifica della scheda', revision, snapshot },
        ],
      );
      await persistConflictErrorIfNeeded(conflict, assertWritable, true);
      throw conflict;
    }

    const revision = writeRevision ?? nextPantryRevision(scope);
    const serialized = serializeSnapshot(snapshot, revision);
    if (!writeLocalStorageSnapshot(serialized, scope, assertWritable)) {
      await onMirrorUnavailable?.();
      return false;
    }
    knownObsoleteLocalMirrors.delete(scope);
    observedPantryCanonicalSnapshots.set(
      scope,
      observedAfterWrite === undefined ? serialized : observedAfterWrite,
    );
    onStored?.();
    return true;
  });
};

const createPantryCompareAndWrite = (
  scope: SyncScope,
  expectedRaw: string | null,
  attemptedRaw: string,
): KeyValueCompareAndWrite<string> => ({
  expectedValue: expectedRaw,
  conflictKey: pantryConflictDatabaseKey(scope),
  preserveConflict: (currentRaw, previousConflict) => {
    const currentSnapshot = currentRaw === null ? null : parsePantrySnapshot(currentRaw);
    const attemptedSnapshot = parsePantrySnapshot(attemptedRaw);
    const copies: PantrySnapshotConflictCopy[] = [
      {
        id: 'indexed-db',
        label: 'Copia IndexedDB',
        revision: pantryRevisionFromRaw(currentRaw),
        snapshot: currentSnapshot ?? { pantryItems: [], stapleIds: [] },
      },
      {
        id: 'concurrent-write',
        label: 'Modifica della scheda',
        revision: pantryRevisionFromRaw(attemptedRaw),
        snapshot: attemptedSnapshot ?? { pantryItems: [], stapleIds: [] },
      },
    ];
    return createConflictBackup(scope, 'concurrent-write', copies, previousConflict);
  },
});

const conflictAfterCompareFailure = async (scope: SyncScope): Promise<PantrySnapshotConflictError> => (
  await getPantrySnapshotConflictError(scope)
  ?? new PantrySnapshotConflictError(scope, 'concurrent-write', { pantryItems: [], stapleIds: [] },
    { pantryItems: [], stapleIds: [] }, null, null, [])
);

const persistPantrySnapshotWithCrossTabCheck = async (
  snapshot: PantrySnapshot,
  scope: SyncScope,
  assertWritable: () => void,
  onStored?: () => void,
  allowMirrorFallback = false,
): Promise<void> => {
  const normalized = normalizePantrySnapshot(snapshot);
  await throwIfPantryConflictActive(scope);

  if (!isIndexedDbAvailable()) {
    const observed = observedPantryCanonicalSnapshots.has(scope)
      ? observedPantryCanonicalSnapshots.get(scope) ?? null
      : readLocalStorageData(scope).raw;
    if (!await persistLocalStorageSnapshotWithCrossTabCheck(normalized, scope, observed, assertWritable, onStored)) {
      throw new Error('Pantry snapshot could not be persisted');
    }
    return;
  }

  // Keep revisions monotonic even when two independently loaded tabs share a pinned clock.
  nextPantryRevision(scope);
  const stored = await nextPantryRevisionAfterStoredRead(scope, assertWritable);
  assertWritable();
  const revision = stored.revision;
  await assertPantrySnapshotsUnambiguous(scope, stored.indexedDbRaw, assertWritable);
  assertWritable();
  const expectedLocalRaw = readLocalStorageData(scope).raw;
  const expectedRaw = stored.indexedDbRaw === null
    ? null
    : observedPantryCanonicalSnapshots.has(scope)
      ? observedPantryCanonicalSnapshots.get(scope) ?? null
      : stored.indexedDbRaw;
  const attemptedRaw = serializeIndexedDbSnapshot(normalized, true, revision);
  const compareAndWrite = createPantryCompareAndWrite(scope, expectedRaw, attemptedRaw);
  let idbCommitted: boolean | void;
  try {
    idbCommitted = await writeKeyValue(scopedPantryDatabaseKey(scope), attemptedRaw, assertWritable, compareAndWrite);
  } catch (error) {
    assertWritable();
    const mirrorPersisted = await persistLocalStorageSnapshotWithCrossTabCheck(
      normalized,
      scope,
      expectedLocalRaw,
      assertWritable,
      () => {
        onStored?.();
        setPendingIndexedDbWrite(scope, true, assertWritable);
      },
      revision,
      stored.indexedDbRaw,
    );
    if (mirrorPersisted) {
      if (allowMirrorFallback) return;
    }
    throw error;
  }
  if (idbCommitted === false) throw await conflictAfterCompareFailure(scope);
  onStored?.();
  assertWritable();
  observedPantryCanonicalSnapshots.set(scope, attemptedRaw);

  let localPersisted = false;
  try {
    localPersisted = await persistLocalStorageSnapshotWithCrossTabCheck(
      normalized,
      scope,
      expectedLocalRaw,
      assertWritable,
      undefined,
      revision,
      attemptedRaw,
      async () => {
        await recordLocalMirrorFreshness(scope, false, assertWritable);
        setPendingIndexedDbWrite(scope, false, assertWritable);
        try {
          getLocalStorage()?.removeItem(scopedPantryStorageKey(scope));
        } catch {
          // A stale mirror cannot outrank the canonical IndexedDB record.
        }
      },
    );
  } catch (error) {
    if (error instanceof PantrySnapshotConflictError) throw error;
    if (!(error instanceof Error) || !/Web Locks/.test(error.message)) throw error;
    if (readLocalStorageData(scope).raw === expectedLocalRaw) {
      knownObsoleteLocalMirrors.set(scope, expectedLocalRaw);
    }
    // IndexedDB is already canonical and remains marked mirror-obsolete. Do not write a
    // local mirror when cross-tab coordination cannot be confirmed.
    return;
  }
  if (!localPersisted) {
    if (readLocalStorageData(scope).raw === expectedLocalRaw) {
      knownObsoleteLocalMirrors.set(scope, expectedLocalRaw);
    }
    return;
  }

  const currentRaw = serializeIndexedDbSnapshot(normalized, false, revision);
  try {
    const markedFresh = await writeKeyValue(
      scopedPantryDatabaseKey(scope),
      currentRaw,
      assertWritable,
      createPantryCompareAndWrite(scope, attemptedRaw, currentRaw),
    );
    if (markedFresh === false) throw await conflictAfterCompareFailure(scope);
  } catch (error) {
    if (error instanceof PantrySnapshotConflictError) throw error;
    // The selected pantry content is already committed to both stores. Leave the embedded
    // freshness flag conservative so IndexedDB remains authoritative on the next read.
    setPendingIndexedDbWrite(scope, true, assertWritable);
    return;
  }
  observedPantryCanonicalSnapshots.set(scope, currentRaw);
  await recordLocalMirrorFreshness(scope, true, assertWritable);
  setPendingIndexedDbWrite(scope, false, assertWritable);
};

function readLocalStorageFallback(name: string, scope: SyncScope = getActiveDataScope()): string | null {
  const storage = getLocalStorage();
  if (storage === null) return null;
  const scopedName = name === PANTRY_STORAGE_KEY ? scopedPantryStorageKey(scope) : name;
  let primaryRaw: string | null;
  try {
    primaryRaw = storage.getItem(scopedName);
  } catch {
    return null;
  }
  if (primaryRaw !== null) return primaryRaw;

  if (name !== PANTRY_STORAGE_KEY || getActiveDataScope() !== 'guest') return null;

  let legacyRaw: string | null;
  try {
    legacyRaw = storage.getItem(LEGACY_PANTRY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (legacyRaw !== null) {
    try {
      storage.setItem(PANTRY_STORAGE_KEY, legacyRaw);
    } catch {
      // The legacy snapshot remains readable even if mirroring it fails.
    }
  }

  return legacyRaw;
}

export async function migrateLegacyPantry(scope: SyncScope = getActiveDataScope()): Promise<boolean> {
  if (scope !== 'guest' || !isIndexedDbAvailable()) return false;

  return withLocalPantryWriteLock(scope, () => migrateLegacyPantryWhileLocked(scope));
}

const migrateLegacyPantryWhileLocked = async (scope: SyncScope): Promise<boolean> => {
  if (scope !== 'guest' || !isIndexedDbAvailable()) return false;
  const existing = await readKeyValue<string>(PANTRY_DATABASE_KEY);
  if (existing !== null && parsePantrySnapshot(existing) !== null) return false;

  const source = readLocalStorageSource();
  if (source === null) {
    if (existing !== null) await deleteKeyValueIfValue(PANTRY_DATABASE_KEY, existing);
    return false;
  }

  const snapshot = parsePantrySnapshot(source.raw);
  if (snapshot === null) return false;
  const sourceRevision = pantryRevisionFromRaw(source.raw);
  const migratedRaw = serializeSnapshot(snapshot, sourceRevision ?? undefined);
  const committed = await writeKeyValue(
    PANTRY_DATABASE_KEY,
    migratedRaw,
    undefined,
    createPantryCompareAndWrite(scope, existing, migratedRaw),
  );
  if (committed === false) throw await conflictAfterCompareFailure(scope);
  rememberPantryRevision(scope, migratedRaw);
  try {
    const storage = getLocalStorage();
    if (storage?.getItem(source.key) === source.raw) storage.removeItem(source.key);
  } catch {
    // Migration succeeded in IndexedDB; the old mirror can be cleaned up later.
  }
  return true;
};

const readCanonicalPantrySnapshot = async (scope: SyncScope): Promise<{
  raw: string | null;
  snapshot: PantrySnapshot | null;
}> => {
  const key = scopedPantryDatabaseKey(scope);
  let raw = await readKeyValue<string>(key);
  let snapshot = raw === null ? null : parsePantrySnapshot(raw);
  if (raw !== null && snapshot === null) {
    if (await deleteKeyValueIfValue(key, raw)) {
      raw = null;
    } else {
      raw = await readKeyValue<string>(key);
      snapshot = raw === null ? null : parsePantrySnapshot(raw);
    }
  }
  rememberPantryRevision(scope, raw);
  observedPantryCanonicalSnapshots.set(scope, raw);
  return { raw, snapshot };
};

const selectPantrySnapshotFromIndexedDb = async (
  scope: SyncScope,
  localData: LocalStoragePantryData,
): Promise<PantrySnapshot | null> => {
  const indexed = await readCanonicalPantrySnapshot(scope);
  const mirrorIsObsolete = indexed.raw !== null && indexed.snapshot !== null
    && await hasObsoleteLocalMirror(scope, indexed.raw);
  return selectPantrySnapshot(
    scope, indexed.raw, indexed.snapshot, localData.raw, localData.snapshot, mirrorIsObsolete,
  );
};

const readPantrySnapshotInternal = async (
  scope: SyncScope,
  pantryWriteLockHeld: boolean,
): Promise<PantrySnapshot | null> => {
  await throwIfPantryConflictActive(scope);
  const pending = pendingPantrySnapshots.get(scope);
  if (pending !== undefined) return parsePantrySnapshot(pending);
  if (!isIndexedDbAvailable()) {
    const raw = readLocalStorageFallback(PANTRY_STORAGE_KEY, scope);
    observedPantryCanonicalSnapshots.set(scope, raw);
    return raw === null ? null : parsePantrySnapshot(raw);
  }

  const localData = readLocalStorageData(scope);
  try {
    if (scope === 'guest' && isIndexedDbAvailable()) {
      if (pantryWriteLockHeld) {
        await migrateLegacyPantryWhileLocked(scope);
      } else {
        const existing = await readKeyValue<string>(PANTRY_DATABASE_KEY);
        if (existing === null || parsePantrySnapshot(existing) === null) await migrateLegacyPantry(scope);
      }
    }
    return await selectPantrySnapshotFromIndexedDb(scope, localData);
  } catch (error) {
    if (error instanceof PantrySnapshotConflictError) throw error;
    try {
      const concurrentSnapshot = await selectPantrySnapshotFromIndexedDb(scope, localData);
      if (concurrentSnapshot !== null) return concurrentSnapshot;
    } catch (rereadError) {
      if (rereadError instanceof PantrySnapshotConflictError) throw rereadError;
    }
    const fallbackRaw = readLocalStorageFallback(PANTRY_STORAGE_KEY, scope);
    const fallbackSnapshot = fallbackRaw === null ? null : parsePantrySnapshot(fallbackRaw);
    if (fallbackSnapshot !== null) return fallbackSnapshot;
    throw error;
  }
};

export async function readPantrySnapshot(scope: SyncScope = getActiveDataScope()): Promise<PantrySnapshot | null> {
  return readPantrySnapshotInternal(scope, false);
}

export async function writePantrySnapshot(snapshot: PantrySnapshot, scope: SyncScope = getActiveDataScope()): Promise<void> {
  return trackScopedWrite(scope, async (assertWritable) => {
    const serialized = serializeSnapshot(snapshot);
    pendingPantrySnapshots.set(scope, serialized);
    try {
      await runPantryWriteInOrder(scope, assertWritable, () => (
        persistPantrySnapshotWithCrossTabCheck(snapshot, scope, assertWritable)
      ));
    } finally {
      if (pendingPantrySnapshots.get(scope) === serialized) pendingPantrySnapshots.delete(scope);
    }
  });
}

export async function recoverPantrySnapshot(scope: SyncScope, selectedCopyId: string): Promise<PantrySnapshot> {
  return trackScopedWrite(scope, async (assertWritable) => runPantryWriteInOrder(scope, assertWritable, () => (
    withLocalPantryWriteLock(scope, async () => {
    let backup = await readPantryConflictBackup(scope);
    if (backup === null) throw new Error('Pantry conflict backup is unavailable');

    if (isIndexedDbAvailable()) {
      const key = pantryConflictDatabaseKey(scope);
      let storedBackup = await readKeyValue<unknown>(key);
      const localSource = readLocalPantryConflictBackup(scope);
      const normalizedStoredBackup = isPantryConflictBackup(storedBackup) && storedBackup.scope === scope
        ? validatedPantryConflictBackup(storedBackup, scope)
        : null;
      const storedCopiesNeedUniqueIds = normalizedStoredBackup !== null
        && isPantryConflictBackup(storedBackup)
        && JSON.stringify(storedBackup.copies) !== JSON.stringify(normalizedStoredBackup.copies);
      if (localSource.backup !== null
        || normalizedStoredBackup === null
        || normalizedStoredBackup.resolvedAt !== undefined
        || storedCopiesNeedUniqueIds) {
        storedBackup = await persistPantryConflictBackupToIndexedDb(scope, backup, assertWritable);
      }
      if (!isPantryConflictBackup(storedBackup) || storedBackup.scope !== scope || storedBackup.resolvedAt !== undefined) {
        throw new Error('Pantry conflict backup could not be restored');
      }
      backup = storedBackup;
      const selected = backup.copies.find((copy) => copy.id === selectedCopyId);
      if (selected === undefined) throw new Error('The selected pantry copy is unavailable');

      const currentRaw = await readKeyValue<string>(scopedPantryDatabaseKey(scope));
      const revision = Math.max(
        Date.now(),
        (latestPantryRevisions.get(scope) ?? 0) + 1,
        (pantryRevisionFromRaw(currentRaw) ?? 0) + 1,
        (selected.revision ?? 0) + 1,
      );
      const normalized = normalizePantrySnapshot(selected.snapshot);
      const selectedRaw = serializeIndexedDbSnapshot(normalized, true, revision);
      const archiveEntry: PantrySnapshotConflictBackup = {
        ...backup,
        selectedCopyId,
      };
      const committed = await commitPantryRecoverySnapshot(
        scopedPantryDatabaseKey(scope),
        key,
        pantryConflictArchiveDatabaseKey(scope),
        backup.id,
        JSON.stringify(backup.copies),
        selectedCopyId,
        selectedRaw,
        archiveEntry,
        assertWritable,
      );
      if (!committed) throw await conflictAfterCompareFailure(scope);
      observedPantryCanonicalSnapshots.set(scope, selectedRaw);
      latestPantryRevisions.set(scope, revision);

      const localPersisted = writeLocalStorageSnapshot(serializeSnapshot(normalized, revision), scope, assertWritable);
      if (!localPersisted) throw new Error('The selected pantry copy could not be written to the browser mirror');

      const finalRaw = serializeIndexedDbSnapshot(normalized, false, revision);
      const finalized = await finalizePantryRecoverySnapshot(
        scopedPantryDatabaseKey(scope),
        key,
        pantryConflictArchiveDatabaseKey(scope),
        backup.id,
        selectedCopyId,
        JSON.stringify(backup.copies),
        selectedRaw,
        finalRaw,
        new Date().toISOString(),
        assertWritable,
      );
      if (!finalized) throw new Error('Pantry conflict recovery could not be finalized');
      observedPantryCanonicalSnapshots.set(scope, finalRaw);
      await recordLocalMirrorFreshness(scope, true, assertWritable);
      setPendingIndexedDbWrite(scope, false, assertWritable);
      if (!deactivatePantryConflict(scope)) throw new Error('Pantry conflict markers could not be cleared');
      return normalized;
    }

    const selected = backup.copies.find((copy) => copy.id === selectedCopyId);
    if (selected === undefined) throw new Error('The selected pantry copy is unavailable');
    const storage = getLocalStorage();
    if (storage === null) throw new Error('Pantry conflict backup is unavailable');
    const archiveKey = pantryConflictArchiveDatabaseKey(scope);
    const previousArchiveRaw = storage.getItem(archiveKey);
    let previousArchive: unknown[] = [];
    let archiveUsesEntriesWrapper = false;
    if (previousArchiveRaw !== null) {
      const parsedArchive = JSON.parse(previousArchiveRaw) as unknown;
      if (Array.isArray(parsedArchive)) {
        previousArchive = parsedArchive;
      } else if (typeof parsedArchive === 'object' && parsedArchive !== null
        && Array.isArray((parsedArchive as { entries?: unknown }).entries)) {
        previousArchive = (parsedArchive as { entries: unknown[] }).entries;
        archiveUsesEntriesWrapper = true;
      } else {
        throw new Error('Pantry conflict archive could not be read');
      }
    }
    const resolved = { ...backup, resolvedAt: new Date().toISOString(), selectedCopyId };
    const existingEntry = previousArchive.find((entry) => isPantryConflictBackupShape(entry)
      && entry.scope === scope && entry.id === backup.id);
    const resolvedEntry = isPantryConflictBackupShape(existingEntry)
      ? {
        ...existingEntry,
        ...resolved,
        copies: uniqueConflictCopies(existingEntry.copies, resolved.copies),
      }
      : resolved;
    const mergedArchive = previousArchive.filter((entry) => !(isPantryConflictBackupShape(entry)
      && entry.scope === scope && entry.id === backup.id));
    mergedArchive.push(resolvedEntry);
    const nextArchiveRaw = JSON.stringify(archiveUsesEntriesWrapper ? { entries: mergedArchive } : mergedArchive);
    const revision = Math.max(Date.now(), (latestPantryRevisions.get(scope) ?? 0) + 1, (selected.revision ?? 0) + 1);
    const normalized = normalizePantrySnapshot(selected.snapshot);
    const selectedRaw = serializeSnapshot(normalized, revision);
    assertWritable();
    storage.setItem(scopedPantryStorageKey(scope), selectedRaw);
    if (storage.getItem(scopedPantryStorageKey(scope)) !== selectedRaw) {
      throw new Error('The selected pantry copy could not be written to the browser mirror');
    }
    observedPantryCanonicalSnapshots.set(scope, selectedRaw);
    latestPantryRevisions.set(scope, revision);

    assertWritable();
    storage.setItem(archiveKey, nextArchiveRaw);
    if (storage.getItem(archiveKey) !== nextArchiveRaw) throw new Error('Pantry conflict archive could not be written');

    const resolvedBackupRaw = JSON.stringify(resolved);
    assertWritable();
    storage.setItem(pantryConflictDatabaseKey(scope), resolvedBackupRaw);
    if (storage.getItem(pantryConflictDatabaseKey(scope)) !== resolvedBackupRaw) {
      throw new Error('Pantry conflict backup could not be recorded');
    }
    if (!deactivatePantryConflict(scope)) throw new Error('Pantry conflict markers could not be cleared');
      return normalized;
    })
  )));
}

export async function clearPantrySnapshot(scope: SyncScope, expectedSnapshot?: PantrySnapshot): Promise<void> {
  const storageKey = scopedPantryStorageKey(scope);
  const databaseKey = scopedPantryDatabaseKey(scope);
  return withLocalPantryWriteLock(scope, async () => {
    const storage = getLocalStorage();
    if (storage === null) throw new Error('Pantry mirror could not be cleared');

    let localRaw: string | null;
    let legacyRaw: string | null = null;
    try {
      localRaw = storage.getItem(storageKey);
      if (scope === 'guest') legacyRaw = storage.getItem(LEGACY_PANTRY_STORAGE_KEY);
    } catch {
      throw new Error('Pantry mirror could not be cleared');
    }
    const localSnapshot = localRaw === null ? null : parsePantrySnapshot(localRaw);
    const legacySnapshot = legacyRaw === null ? null : parsePantrySnapshot(legacyRaw);
    const indexedDbAvailable = isIndexedDbAvailable();
    const indexedDbRaw = indexedDbAvailable ? await readKeyValue<string>(databaseKey) : null;
    const indexedDbSnapshot = indexedDbRaw === null ? null : parsePantrySnapshot(indexedDbRaw);

    if (expectedSnapshot !== undefined) {
      const expectedFingerprint = pantrySnapshotFingerprint(expectedSnapshot);
      if (indexedDbRaw !== null && (indexedDbSnapshot === null
        || pantrySnapshotFingerprint(indexedDbSnapshot) !== expectedFingerprint)) return;
      if (localRaw !== null && (localSnapshot === null
        || pantrySnapshotFingerprint(localSnapshot) !== expectedFingerprint)) return;
      if (legacyRaw !== null && (legacySnapshot === null
        || pantrySnapshotFingerprint(legacySnapshot) !== expectedFingerprint)) return;
    }

    if (indexedDbAvailable && !await deleteKeyValueIfValue(databaseKey, indexedDbRaw)) return;

    try {
      if (storage.getItem(storageKey) !== localRaw) return;
      if (localRaw !== null) storage.removeItem(storageKey);
      storage.removeItem(pendingIndexedDbStorageKey(scope));
      if (scope === 'guest' && legacyRaw !== null
        && storage.getItem(LEGACY_PANTRY_STORAGE_KEY) === legacyRaw) {
        storage.removeItem(LEGACY_PANTRY_STORAGE_KEY);
      }
    } catch {
      throw new Error('Pantry mirror could not be cleared');
    }
    observedPantryCanonicalSnapshots.delete(scope);
  });
}

export const pantryStorage: StateStorage = {
  async getItem(name) {
    if (name !== PANTRY_STORAGE_KEY) return readLocalStorageFallback(name);
    const scope = getActiveDataScope();
    await throwIfPantryConflictActive(scope);
    const pending = pendingPantrySnapshots.get(scope);
    if (pending !== undefined) return pending;
    if (!isIndexedDbAvailable()) {
      const raw = readLocalStorageFallback(name, scope);
      observedPantryCanonicalSnapshots.set(scope, raw);
      return raw;
    }

    const snapshot = await readPantrySnapshotInternal(scope, false);
    return snapshot === null ? null : serializeSnapshot(snapshot);
  },
  async setItem(name, value) {
    if (pantryPersistenceSuspended) return;
    const scope = getActiveDataScope();
    let writeCompleted = false;
    try {
      await trackScopedWrite(scope, async (assertWritable) => {
        if (name !== PANTRY_STORAGE_KEY) {
          assertWritable();
          try {
            getLocalStorage()?.setItem(name, value);
          } catch {
            // The key is not mirrored when browser storage is unavailable.
          }
          writeCompleted = true;
          return;
        }

        const parsed = parsePantrySnapshot(value);
        const persistedValue = parsed === null ? value : serializeSnapshot(parsed);
        pendingPantrySnapshots.set(scope, persistedValue);
        try {
          await runPantryWriteInOrder(scope, assertWritable, async () => {
            if (parsed !== null) {
              await persistPantrySnapshotWithCrossTabCheck(
                parsed,
                scope,
                assertWritable,
                () => { writeCompleted = true; },
                true,
              );
              return;
            }

            await throwIfPantryConflictActive(scope);
            const stored = isIndexedDbAvailable()
              ? await nextPantryRevisionAfterStoredRead(scope, assertWritable)
              : { revision: nextPantryRevision(scope), indexedDbRaw: null };
            await assertPantrySnapshotsUnambiguous(scope, stored.indexedDbRaw, assertWritable);
            assertWritable();
            const localPersisted = writeLocalStorageSnapshot(value, scope, assertWritable);
            if (isIndexedDbAvailable() && stored.indexedDbRaw !== null) {
              const attemptedRaw = value;
              const expectedRaw = observedPantryCanonicalSnapshots.has(scope)
                ? observedPantryCanonicalSnapshots.get(scope) ?? null
                : stored.indexedDbRaw;
              const written = await writeKeyValue(
                scopedPantryDatabaseKey(scope),
                attemptedRaw,
                assertWritable,
                createPantryCompareAndWrite(scope, expectedRaw, attemptedRaw),
              );
              if (written === false) throw await conflictAfterCompareFailure(scope);
              observedPantryCanonicalSnapshots.set(scope, attemptedRaw);
            }
            if (!localPersisted && !isIndexedDbAvailable()) throw new Error('Pantry snapshot could not be persisted');
            writeCompleted = true;
          });
        } finally {
          if (pendingPantrySnapshots.get(scope) === persistedValue) pendingPantrySnapshots.delete(scope);
        }
      });
    } catch (error) {
      if (!(writeCompleted && error instanceof ScopeUncertainError)) throw error;
    }
  },
  async removeItem(name) {
    if (name === PANTRY_STORAGE_KEY) await throwIfPantryConflictActive(getActiveDataScope());
    const storage = getLocalStorage();
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      try {
        storage?.removeItem(name);
      } catch {
        // Nothing durable can be removed from browser storage in this environment.
      }
      return;
    }

    await deleteKeyValue(scopedPantryDatabaseKey());
    try {
      storage?.removeItem(scopedPantryStorageKey());
    } catch {
      // IndexedDB deletion is authoritative; a failed mirror cleanup is harmless.
    }
  },
};
