import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '../domain/ingredients';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import PantryPage from './PantryPage';
import { usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';
import { readPantrySnapshot, PANTRY_STORAGE_KEY } from '../storage/pantryStorage';
import * as pantryStorageModule from '../storage/pantryStorage';
import { writeKeyValue, readKeyValue } from '../storage/indexedDb';
import { setActiveDataScope, setPersonalDataScope, scopeStorageKey } from '../sync/scopeContext';

const hydratePantryStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../store/localPantryStore', async () => {
  const actual = await vi.importActual<typeof import('../store/localPantryStore')>('../store/localPantryStore');
  return { ...actual, hydratePantryStore: hydratePantryStoreMock };
});

const renderPantry = (): void => {
  render(
    <MemoryRouter>
      <PantryPage />
    </MemoryRouter>,
  );
};

const seedPantry = (value: string): void => {
  act(() => {
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: parseIngredientInput(value),
      pantryLots: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
  });
};

const openDisclosure = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
  const summary = screen.getByText(name, { exact: true });
  const disclosure = summary.closest('details');
  if (disclosure === null) throw new Error(`${name} must be a disclosure`);
  if (!disclosure.hasAttribute('open')) await user.click(summary);
};

const seedPantryConflict = async (): Promise<void> => {
  await writeKeyValue('pantry', JSON.stringify({
    state: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] },
    version: 1,
    revision: 42,
    mirrorObsolete: true,
  }));
  window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify({
    state: { pantryItems: [{ id: 'rice', label: 'Riso', known: true }], stapleIds: [] },
    version: 1,
  }));
  window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');

  try {
    await readPantrySnapshot('guest');
    throw new Error('Expected a pantry snapshot conflict');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'pantry_snapshot_conflict') throw error;
    reportPersistenceMemoryOnly('pantry', error, vi.fn(async () => undefined));
  }
};

describe('PantryPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
    hydratePantryStoreMock.mockReset();
    hydratePantryStoreMock.mockResolvedValue(undefined);
    usePersistenceStatusStore.getState().reset();
    pantryStorageModule.setPantryPersistenceSuspended(true);
    try {
      usePantryStore.setState({
        hasHydrated: true,
        pantryItems: [],
        pantryLots: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      });
    } finally {
      pantryStorageModule.setPantryPersistenceSuspended(false);
    }
    useDietProfileStore.setState({
      hasHydrated: true,
      profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-13T12:00:00.000Z' },
    });
  });

  it('shows a dedicated loading state while pantry hydration is pending', () => {
    usePantryStore.setState({ hasHydrated: false });
    renderPantry();

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento della tua dispensa…');
    expect(hydratePantryStoreMock).toHaveBeenCalledOnce();
  });

  it('owns ingredient entry and shows added items in the pantry', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pasta, tonno');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    const pantry = screen.getByRole('list', { name: 'La tua dispensa' });
    expect(within(pantry).getByText('Pasta')).toBeVisible();
    expect(within(pantry).getByText('Tonno')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Vai alle ricette' })).toHaveAttribute('href', '/');
  });

  it('does not expose a keyboard-activatable recipe link while the pantry is empty', () => {
    renderPantry();

    expect(screen.queryByRole('link', { name: 'Vai alle ricette' })).not.toBeInTheDocument();
    expect(screen.getByText('Vai alle ricette')).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers known ingredients while an ingredient is being typed', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pom');

    const suggestions = screen.getByRole('listbox', { name: 'Ingredienti suggeriti' });
    expect(within(suggestions).getByRole('option', { name: 'Pomodoro' })).toBeVisible();
    await user.click(within(suggestions).getByRole('option', { name: 'Pomodoro' }));
    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Pomodoro')).toBeVisible();
  });

  it('keeps expansion ideas and pantry configuration in progressive disclosure', async () => {
    const user = userEvent.setup();
    renderPantry();

    const ideas = screen.getByText('Idee per ampliare la dispensa', { exact: true }).closest('details');
    const configuration = screen.getByText('Personalizza la dispensa', { exact: true }).closest('details');
    expect(ideas).not.toHaveAttribute('open');
    expect(configuration).not.toHaveAttribute('open');

    await openDisclosure(user, 'Idee per ampliare la dispensa');
    expect(screen.getByRole('region', { name: 'Potresti aggiungere' })).toBeVisible();

    await openDisclosure(user, 'Personalizza la dispensa');
    expect(screen.getByText('Filtri alimentari', { exact: true })).toBeVisible();
    expect(screen.getByText('Ingredienti di base', { exact: true })).toBeVisible();
  });

  it('adds useful pantry suggestions without returning to Home', async () => {
    const user = userEvent.setup();
    renderPantry();

    await openDisclosure(user, 'Idee per ampliare la dispensa');
    const suggestions = screen.getByRole('region', { name: 'Potresti aggiungere' });
    await user.click(within(suggestions).getByRole('button', { name: 'Aggiungi Cipolla' }));

    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Cipolla')).toBeVisible();
    expect(within(suggestions).queryByRole('button', { name: 'Aggiungi Cipolla' })).not.toBeInTheDocument();
  });

  it('keeps unknown ingredients and explains that recipes do not match them yet', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'Tempeh');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    expect(screen.getByText('Tempeh')).toBeVisible();
    expect(screen.getByText('Non ancora usato nelle ricette')).toBeVisible();
  });

  it('keeps staple and lot management inside pantry configuration', async () => {
    const user = userEvent.setup();
    seedPantry('pasta');
    renderPantry();

    await openDisclosure(user, 'Personalizza la dispensa');
    await user.click(screen.getByText('Ingredienti di base', { exact: true }));
    const salt = screen.getByLabelText('Sale');
    expect(salt).toBeChecked();
    await user.click(salt);
    expect(salt).not.toBeChecked();
    expect(screen.getByText('Dettagli lotti', { exact: true })).toBeVisible();
  });

  it('hides previous-scope conflict and archive copies after a mounted pantry switches to an account', async () => {
    const guestCopies = [
      {
        id: 'guest-indexed-db',
        label: 'Guest conflict PRIVATE indexed copy',
        revision: 42,
        snapshot: { pantryItems: [{ id: 'guest-conflict-item', label: 'Guest conflict PRIVATE ingredient', known: true }], stapleIds: [] },
      },
      {
        id: 'guest-local-storage',
        label: 'Guest conflict PRIVATE local copy',
        revision: null,
        snapshot: { pantryItems: [{ id: 'guest-local-item', label: 'Guest local PRIVATE ingredient', known: true }], stapleIds: [] },
      },
    ];
    const guestConflict = new pantryStorageModule.PantrySnapshotConflictError(
      'guest', 'concurrent-write', guestCopies[0]!.snapshot, guestCopies[1]!.snapshot, 42, null, guestCopies,
    );
    await writeKeyValue(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'), {
      entries: [{
        id: 'guest-archive',
        scope: 'guest',
        reason: 'concurrent-write',
        createdAt: '2026-10-08T10:00:00.000Z',
        resolvedAt: '2026-10-08T10:01:00.000Z',
        selectedCopyId: 'guest-indexed-db',
        copies: guestCopies,
      }],
    });
    await writeKeyValue(scopeStorageKey('account:alice', 'ikuck-pantry-conflict-archive-v1'), {
      entries: [{
        id: 'account-archive',
        scope: 'account:alice',
        reason: 'concurrent-write',
        createdAt: '2026-10-08T11:00:00.000Z',
        resolvedAt: '2026-10-08T11:01:00.000Z',
        selectedCopyId: 'account-indexed-db',
        copies: [
          {
            id: 'account-indexed-db',
            label: 'Account archive PRIVATE indexed copy',
            revision: 43,
            snapshot: { pantryItems: [{ id: 'account-indexed-item', label: 'Account archive PRIVATE ingredient', known: true }], stapleIds: [] },
          },
          {
            id: 'account-local-storage',
            label: 'Account archive PRIVATE local copy',
            revision: null,
            snapshot: { pantryItems: [{ id: 'account-local-item', label: 'Account local PRIVATE ingredient', known: true }], stapleIds: [] },
          },
        ],
      }],
    });
    await expect(pantryStorageModule.readPantryConflictArchive('account:alice')).resolves.toMatchObject([{ id: 'account-archive' }]);
    const user = userEvent.setup();
    renderPantry();

    expect(await screen.findByText('Copie archiviate della dispensa', { exact: true })).toBeVisible();
    await openDisclosure(user, 'Copie archiviate della dispensa');
    expect(await screen.findByRole('radio', { name: /Guest conflict PRIVATE local copy/ })).toBeVisible();
    act(() => reportPersistenceMemoryOnly('pantry', guestConflict, vi.fn(async () => undefined)));
    expect(screen.getByRole('radiogroup', { name: 'Seleziona la copia da ripristinare' })).toBeVisible();

    await act(async () => {
      setActiveDataScope('account:alice');
      usePantryStore.setState({
        hasHydrated: true,
        pantryItems: parseIngredientInput('Account-only ingredient'),
        pantryLots: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      });
    });

    expect(screen.getByText('Account-only ingredient')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Seleziona la copia da ripristinare' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Guest conflict PRIVATE|Guest local PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Guest conflict PRIVATE ingredient|Guest local PRIVATE ingredient/)).not.toBeInTheDocument();

    expect(await screen.findByText('Copie archiviate della dispensa', { exact: true })).toBeVisible();
    await openDisclosure(user, 'Copie archiviate della dispensa');
    expect(await screen.findByRole('radio', { name: /Account archive PRIVATE indexed copy/ })).toBeVisible();
    expect(screen.queryByText(/Guest conflict PRIVATE|Guest local PRIVATE/)).not.toBeInTheDocument();
  });

  it('does not claim a second preserved copy for a one-copy pantry conflict', () => {
    const copy = {
      id: 'only-recoverable-copy',
      label: 'Backup selezionabile',
      revision: 42,
      snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] },
    };
    const conflict = new pantryStorageModule.PantrySnapshotConflictError(
      'guest', 'concurrent-write', copy.snapshot, copy.snapshot, 42, 42, [copy],
    );
    reportPersistenceMemoryOnly('pantry', conflict, vi.fn(async () => undefined));
    renderPantry();

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent(/due copie|entrambe le copie|copia non scelta/i);
    expect(alert).toHaveTextContent('una copia recuperabile');
    expect(alert).toHaveTextContent('La copia resta nel backup');
    expect(within(alert).getByRole('radio', { name: /Backup selezionabile/ })).toBeVisible();
    expect(within(alert).getByRole('button', { name: 'Usa questa copia' })).toBeDisabled();
  });

  it('explains the number of recoverable pantry copies when snapshots conflict', () => {
    const conflict = Object.assign(new Error('Pantry snapshots conflict'), {
      code: 'pantry_snapshot_conflict',
      scope: 'guest',
      copies: [
        { id: 'first-copy', label: 'Prima', snapshot: { pantryItems: [], stapleIds: [] } },
        { id: 'second-copy', label: 'Seconda', snapshot: { pantryItems: [], stapleIds: [] } },
      ],
    });
    reportPersistenceMemoryOnly('pantry', conflict, vi.fn(async () => undefined));
    renderPantry();

    expect(screen.getByRole('alert')).toHaveTextContent('2 copie recuperabili');
    expect(screen.getByRole('alert')).toHaveTextContent('Sono tutte conservate');
    expect(screen.getByRole('alert')).toHaveTextContent('scritture sono sospese');
  });

  it('explains that a malformed pantry backup is preserved but no safe copy is selectable', () => {
    const error = new pantryStorageModule.PantrySnapshotConflictBackupError('guest');
    reportPersistenceMemoryOnly('pantry', error, vi.fn(async () => undefined));
    renderPantry();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Il backup della dispensa è stato conservato, ma i dati non sono leggibili.');
    expect(alert).toHaveTextContent('Non è disponibile alcuna copia sicura da scegliere');
    expect(alert).toHaveTextContent('le modifiche e la sincronizzazione restano sospese');
    expect(alert).not.toHaveTextContent(/due copie|entrambe le copie|scegli una copia/i);
    expect(screen.queryByRole('radiogroup', { name: 'Seleziona la copia da ripristinare' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Usa questa copia' })).not.toBeInTheDocument();
  });

  it('offers an accessible explicit choice between both preserved pantry copies', async () => {
    const conflict = Object.assign(new Error('Pantry snapshots conflict'), {
      code: 'pantry_snapshot_conflict',
      scope: 'guest',
      copies: [
        {
          id: 'indexed-db',
          label: 'Copia IndexedDB',
          snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] },
        },
        {
          id: 'local-storage',
          label: 'Copia localStorage',
          snapshot: { pantryItems: [{ id: 'rice', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    });
    reportPersistenceMemoryOnly('pantry', conflict, vi.fn(async () => undefined));
    renderPantry();

    const choices = screen.getByRole('radiogroup', { name: 'Seleziona la copia da ripristinare' });
    const indexedCopy = within(choices).getByRole('radio', { name: /Copia IndexedDB.*Pasta/s });
    const localCopy = within(choices).getByRole('radio', { name: /Copia localStorage.*Riso/s });
    const recover = screen.getByRole('button', { name: 'Usa questa copia' });
    expect(indexedCopy).toBeVisible();
    expect(localCopy).toBeVisible();
    expect(recover).toBeDisabled();

    await userEvent.setup().click(localCopy);

    expect(recover).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
  });

  it('shows newly appended conflict copies and requires a fresh choice when recovery races a writer', async () => {
    const copies = [
      {
        id: 'indexed-db',
        label: 'Copia IndexedDB',
        revision: 42,
        snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] },
      },
      {
        id: 'local-storage',
        label: 'Copia localStorage',
        revision: null,
        snapshot: { pantryItems: [{ id: 'rice', label: 'Riso', known: true }], stapleIds: [] },
      },
    ];
    const initialConflict = new pantryStorageModule.PantrySnapshotConflictError(
      'guest', 'concurrent-write', copies[0].snapshot, copies[1].snapshot, 42, null, copies,
    );
    reportPersistenceMemoryOnly('pantry', initialConflict, vi.fn(async () => undefined));
    await writeKeyValue(scopeStorageKey('guest', 'ikuck-pantry-conflict-backup-v1'), {
      id: 'active-conflict',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-08T10:00:00.000Z',
      copies,
    });
    const concurrentCopy = {
      id: 'concurrent-tab',
      label: 'Modifica concorrente',
      revision: 43,
      snapshot: { pantryItems: [{ id: 'beans', label: 'Fagioli', known: true }], stapleIds: [] },
    };
    const expandedConflict = new pantryStorageModule.PantrySnapshotConflictError(
      'guest', 'concurrent-write', copies[0].snapshot, concurrentCopy.snapshot, 42, 43, [...copies, concurrentCopy],
    );
    const failedRecovery = vi.spyOn(pantryStorageModule, 'recoverPantrySnapshot').mockRejectedValue(expandedConflict);

    try {
      renderPantry();
      const user = userEvent.setup();
      await user.click(screen.getByRole('radio', { name: /Copia localStorage.*Riso/s }));
      await user.click(screen.getByRole('button', { name: 'Usa questa copia' }));

      expect(await screen.findByRole('radio', { name: /Modifica concorrente.*Fagioli/s })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Usa questa copia' })).toBeDisabled();
      expect(screen.getByText(/Il recupero non è riuscito/)).toBeVisible();
    } finally {
      failedRecovery.mockRestore();
    }
  });

  it('refreshes archived conflict copies immediately after active-conflict recovery', async () => {
    await seedPantryConflict();
    const user = userEvent.setup();
    renderPantry();

    await user.click(screen.getByRole('radio', { name: /Copia localStorage.*Riso/s }));
    await user.click(screen.getByRole('button', { name: 'Usa questa copia' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Riso')).toBeVisible();
    const archiveSummary = await screen.findByText('Copie archiviate della dispensa', { exact: true });
    expect(archiveSummary).toBeVisible();

    await user.click(archiveSummary);
    const archivedChoices = screen.getByRole('radiogroup', { name: /Seleziona una copia archiviata del recupero/ });
    expect(within(archivedChoices).getByRole('radio', { name: /Copia IndexedDB.*Pasta/s })).toBeVisible();
    const archivedRice = within(archivedChoices).getByRole('radio', { name: /Copia localStorage.*Riso/s });
    expect(archivedRice).toBeVisible();
    const restore = screen.getByRole('button', { name: 'Ripristina copia archiviata' });
    expect(restore).toBeDisabled();
    await user.click(archivedRice);
    expect(restore).toBeEnabled();
  });

  it('recovers the selected copy only after confirmation and preserves the other in the archive', async () => {
    await seedPantryConflict();
    const user = userEvent.setup();
    renderPantry();

    const localCopy = screen.getByRole('radio', { name: /Copia localStorage.*Riso/s });
    const recover = screen.getByRole('button', { name: 'Usa questa copia' });
    expect(recover).toBeDisabled();
    await user.click(localCopy);
    await user.click(recover);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Riso')).toBeVisible();
    const archive = await readKeyValue<{ entries: Array<{ selectedCopyId: string }> }>(
      'ikuck:guest:ikuck-pantry-conflict-archive-v1',
    );
    expect(archive?.entries[0]?.selectedCopyId).toBe('local-storage');
  });

  it('lets a user explicitly restore a visible archived copy while preserving the current pantry', async () => {
    const currentSnapshot = { pantryItems: parseIngredientInput('Pomodoro'), stapleIds: [...DEFAULT_STAPLE_IDS] };
    const archivedConflict = {
      id: 'historic-conflict',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-07T10:00:00.000Z',
      resolvedAt: '2026-10-07T10:01:00.000Z',
      selectedCopyId: 'indexed-db',
      copies: [
        {
          id: 'indexed-db',
          label: 'Copia IndexedDB',
          revision: 41,
          snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] },
        },
        {
          id: 'local-storage',
          label: 'Copia localStorage',
          revision: null,
          snapshot: { pantryItems: [{ id: 'rice', label: 'Riso', known: true }], stapleIds: ['pepper'] },
        },
      ],
    };
    const persistedCurrent = JSON.stringify({ state: currentSnapshot, version: 1, revision: 60, mirrorObsolete: false });
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedCurrent);
    await writeKeyValue('pantry', persistedCurrent);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject(currentSnapshot);
    await writeKeyValue(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'), { entries: [archivedConflict] });
    pantryStorageModule.setPantryPersistenceSuspended(true);
    try {
      seedPantry('Pomodoro');
    } finally {
      pantryStorageModule.setPantryPersistenceSuspended(false);
    }
    const user = userEvent.setup();
    renderPantry();

    await user.click(await screen.findByText('Copie archiviate della dispensa', { exact: true }));
    const choices = screen.getByRole('radiogroup', { name: /Seleziona una copia archiviata del recupero/ });
    expect(within(choices).getByRole('radio', { name: /Copia IndexedDB.*Pasta/s })).toBeVisible();
    const archivedRice = within(choices).getByRole('radio', { name: /Copia localStorage.*Riso/s });
    expect(archivedRice).toBeVisible();
    const restore = screen.getByRole('button', { name: 'Ripristina copia archiviata' });
    expect(restore).toBeDisabled();
    await user.click(archivedRice);
    await user.click(restore);

    await waitFor(() => expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Riso')).toBeVisible());
    const updatedArchive = await readKeyValue<{ entries: Array<{
      id: string;
      selectedCopyId?: string;
      copies: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }>;
    }> }>(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'));
    expect(updatedArchive?.entries.some((entry) => entry.selectedCopyId === 'local-storage'
      && entry.copies.some((copy) => copy.snapshot.pantryItems.some((item) => item.id === currentSnapshot.pantryItems[0]?.id))
      && entry.copies.some((copy) => copy.snapshot.pantryItems.some((item) => item.id === 'rice')))).toBe(true);
    expect(updatedArchive?.entries.some((entry) => entry.id === 'historic-conflict')).toBe(true);
  });

  it('keeps the recovery choice visible and writes blocked when confirmation cannot persist', async () => {
    await seedPantryConflict();
    const user = userEvent.setup();
    renderPantry();
    await user.click(screen.getByRole('radio', { name: /Copia localStorage.*Riso/s }));

    const originalSetItem = Storage.prototype.setItem;
    const blockedMirrorWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY && value.includes('"id":"rice"')) {
        throw new DOMException('Storage disabled', 'SecurityError');
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      await user.click(screen.getByRole('button', { name: 'Usa questa copia' }));
      expect(await screen.findByText(/Il recupero non è riuscito/)).toHaveAttribute('role', 'status');
      expect(screen.getByRole('radio', { name: /Copia localStorage.*Riso/s })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Usa questa copia' })).toBeEnabled();
      const backup = await readKeyValue<{ resolvedAt?: string; copies: unknown[] }>(
        'ikuck:guest:ikuck-pantry-conflict-backup-v1',
      );
      expect(backup?.resolvedAt).toBeUndefined();
      expect(backup?.copies).toHaveLength(2);
      await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    } finally {
      blockedMirrorWrite.mockRestore();
    }
  });

  it('shows a persistence warning and retry action in the section that owns pantry data', async () => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', new Error('IndexedDB unavailable'), retry);
    renderPantry();

    expect(screen.getByRole('alert')).toHaveTextContent('disponibili solo in memoria');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Riprova' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
