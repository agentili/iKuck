import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NotificationCenter from './NotificationCenter';
import { usePantryStore } from '../../store/localPantryStore';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
import { useAuthStore } from '../../auth/authStore';
import { usePersistenceStatusStore } from '../../store/persistenceStatusStore';
import { subscribeSyncStatus, type SyncStatusSnapshot } from '../../sync/syncQueue';
import type { PantryLot } from '@ikuck/shared/contracts';

vi.mock('../../sync/syncQueue', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../sync/syncQueue')>(),
  subscribeSyncStatus: vi.fn(() => () => {}),
}));

const lot = (expiresAt: string): PantryLot => ({ id: 'milk', ingredientId: 'milk', label: 'Latte', known: true, quantity: null, unit: null, expiresAt, createdAt: '', updatedAt: '' });
const status = (state: 'saving' | 'saved' | 'memory-only' | 'sync-pending' | 'sync-error') => {
  act(() => usePersistenceStatusStore.getState().setStatus('activity', { state, error: null, retry: null }));
};
beforeEach(() => {
  vi.clearAllMocks();
  setActiveDataScope('guest');
  usePantryStore.setState({ pantryLots: [] });
  useAuthStore.setState({ user: null });
  usePersistenceStatusStore.getState().reset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('announces network errors and allows dismissal', async () => {
  render(<NotificationCenter />);
  act(() => { window.dispatchEvent(new Event('app:network-error')); });
  expect(screen.getByText(/Connessione non disponibile/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Chiudi notifica' }));
  expect(screen.queryByText(/Connessione non disponibile/)).not.toBeInTheDocument();
});
it('does not retain notices when the data scope changes', () => {
  render(<NotificationCenter />);
  act(() => { window.dispatchEvent(new Event('offline')); });
  expect(screen.getByText(/Sei offline/)).toBeVisible();
  act(() => { setActiveDataScope('account:other'); });
  expect(screen.queryByText(/Sei offline/)).not.toBeInTheDocument();
});

it('announces local saves only after persistence completes, and distinguishes sync completion', () => {
  render(<NotificationCenter />);
  status('saving');
  expect(screen.queryByText(/salvate sul dispositivo/)).not.toBeInTheDocument();
  status('memory-only');
  expect(screen.getByText(/Salvataggio sul dispositivo non riuscito/)).toBeVisible();
  expect(screen.queryByText(/salvate sul dispositivo/)).not.toBeInTheDocument();
  status('saving');
  status('saved');
  expect(screen.getByText('Attività e preferenze salvate sul dispositivo.')).toBeVisible();
  status('sync-pending');
  status('saved');
  expect(screen.queryByText('Sincronizzazione eseguita.')).not.toBeInTheDocument();
});

it('ignores persistence completion from work started before switching scope', () => {
  render(<NotificationCenter />);
  status('saving');
  act(() => setActiveDataScope('house:other'));
  status('saved');
  expect(screen.queryByText(/salvate sul dispositivo/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Sincronizzazione completata/)).not.toBeInTheDocument();
});

it('deduplicates repeated network errors', () => {
  render(<NotificationCenter />);
  act(() => {
    window.dispatchEvent(new Event('app:network-error'));
    window.dispatchEvent(new Event('app:network-error'));
  });
  expect(screen.getAllByText(/Connessione non disponibile/)).toHaveLength(1);
});

it('deduplicates expiry notices and announces edited expiry and the next local day', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26, 23, 59));
  usePantryStore.setState({ pantryLots: [lot('2026-10-26')] });
  render(<NotificationCenter />);
  expect(screen.getByText('Latte: in scadenza (26/10/2026).')).toBeVisible();
  act(() => usePantryStore.setState({ pantryLots: [lot('2026-10-26')] }));
  expect(screen.getAllByText(/Latte:/)).toHaveLength(1);
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText('Latte: scaduto (26/10/2026).')).toBeVisible();
  expect(screen.queryByText('Latte: in scadenza (26/10/2026).')).not.toBeInTheDocument();
  act(() => usePantryStore.setState({ pantryLots: [lot('2026-10-29')] }));
  expect(screen.getByText('Latte: in scadenza (29/10/2026).')).toBeVisible();
  expect(screen.queryByText('Latte: scaduto (26/10/2026).')).not.toBeInTheDocument();
  act(() => usePantryStore.setState({ pantryLots: [] }));
  expect(screen.queryByText(/Latte:/)).not.toBeInTheDocument();
});

it('clears notices on user and personal scope changes and ignores stale sync callbacks', () => {
  const callbacks: ((status: SyncStatusSnapshot) => void)[] = [];
  vi.mocked(subscribeSyncStatus).mockImplementation((_scope, callback) => { callbacks.push(callback); return () => {}; });
  useAuthStore.setState({ user: { id: 'a', email: 'a@example.com', emailVerifiedAt: '2026-10-01' } });
  render(<NotificationCenter />);
  act(() => callbacks[0]({ state: 'success', error: null }));
  expect(screen.getByText('Sincronizzazione eseguita.')).toBeVisible();
  act(() => setActiveDataScope('house:other'));
  expect(screen.queryByText('Sincronizzazione eseguita.')).not.toBeInTheDocument();
  act(() => callbacks[0]({ state: 'success', error: null }));
  expect(screen.queryByText('Sincronizzazione eseguita.')).not.toBeInTheDocument();
  act(() => callbacks.at(-1)?.({ state: 'success', error: null }));
  expect(screen.getAllByText('Sincronizzazione eseguita.')).toHaveLength(1);
  act(() => setPersonalDataScope('account:b'));
  expect(screen.queryByText('Sincronizzazione eseguita.')).not.toBeInTheDocument();
  act(() => useAuthStore.setState({ user: null }));
  act(() => callbacks.at(-1)?.({ state: 'error', error: null }));
  expect(screen.queryByText(/Sincronizzazione non riuscita/)).not.toBeInTheDocument();
});

it('lets page accordions receive pointer events while keeping notification dismissal interactive', async () => {
  const user = userEvent.setup();
  render(<><details><summary>Consenso AI per Dinner</summary><p>Opzioni del diario</p></details><NotificationCenter /></>);
  status('saving');
  status('saved');
  const center = screen.getByRole('complementary', { name: 'Notifiche' });
  expect(center).toHaveStyle({ pointerEvents: 'none' });
  expect(screen.getByRole('button', { name: 'Chiudi notifica' })).toHaveStyle({ pointerEvents: 'auto' });
  await user.click(screen.getByText('Consenso AI per Dinner'));
  expect(screen.getByText('Opzioni del diario')).toBeVisible();
  expect(screen.getByText('Attività e preferenze salvate sul dispositivo.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Chiudi notifica' }));
  expect(screen.queryByText('Attività e preferenze salvate sul dispositivo.')).not.toBeInTheDocument();
});

it('expires sync success notices while keeping actionable errors available', () => {
  vi.useFakeTimers();
  let onSync: ((status: SyncStatusSnapshot) => void) | undefined;
  vi.mocked(subscribeSyncStatus).mockImplementation((_scope, callback) => { onSync = callback; return () => {}; });
  useAuthStore.setState({ user: { id: 'a', email: 'a@example.com', emailVerifiedAt: '2026-10-01' } });
  render(<NotificationCenter />);
  act(() => onSync?.({ state: 'success', error: null }));
  act(() => window.dispatchEvent(new Event('app:network-error')));
  expect(screen.getByText('Sincronizzazione eseguita.')).toBeVisible();
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByText('Sincronizzazione eseguita.')).not.toBeInTheDocument();
  expect(screen.getByText(/Connessione non disponibile/)).toBeVisible();
});

it('retains a transient notice when its close button has keyboard focus', () => {
  vi.useFakeTimers();
  render(<NotificationCenter />);
  status('saving');
  status('saved');
  const close = screen.getByRole('button', { name: 'Chiudi notifica' });
  close.focus();
  act(() => vi.advanceTimersByTime(6000));
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(screen.queryByText('Attività e preferenze salvate sul dispositivo.')).not.toBeInTheDocument();
});
