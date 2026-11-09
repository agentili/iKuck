import { ApiClientError } from '../api/apiClient';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../auth/authStore';
import PushSettings from './PushSettings';
import * as client from './client';
vi.mock('./client', () => ({
  supportsPush: vi.fn(() => true), reconcilePushAccount: vi.fn(), browserSubscription: vi.fn().mockResolvedValue(null),
  getPushStatus: vi.fn(), getDeviceSubscriptions: vi.fn().mockResolvedValue([]), savePushPreferences: vi.fn(),
  enableDevicePush: vi.fn().mockResolvedValue('device-id'), deleteDeviceSubscription: vi.fn(), clearLocalPush: vi.fn().mockResolvedValue(undefined), sendPushTest: vi.fn(),
}));
const status = { enabled: true, publicKey: 'public', preferencesConfigured: true, preferences: { enabled: false, fridayTime: '19:00', timeZone: 'Europe/Rome' }, effectiveTimeZone: 'Europe/Rome' };
const user = { id: 'push-user', email: 'push@example.com', emailVerifiedAt: '2026-01-01' };
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(client.getPushStatus).mockResolvedValue(status);
  vi.stubGlobal('Notification', { permission: 'default' });
  useAuthStore.setState({ user, csrfToken: 'csrf' });
});
describe('Push settings', () => {
  it('explains account requirement to guests without requesting permission', () => {
    useAuthStore.setState({ user: null });
    render(<MemoryRouter><PushSettings /></MemoryRouter>);
    expect(screen.getByText(/Accedi con un account verificato/)).toBeInTheDocument();
    expect(client.enableDevicePush).not.toHaveBeenCalled();
  });
  it('activates only after an explicit click and saves the weekly preference', async () => {
    render(<MemoryRouter><PushSettings /></MemoryRouter>);
    const enable = await screen.findByRole('button', { name: 'Attiva notifiche' });
    expect(client.enableDevicePush).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await screen.findByText('Notifiche attive su questo dispositivo.');
    expect(client.savePushPreferences).toHaveBeenCalledWith({ ...status.preferences, enabled: true }, 'csrf');
    expect(screen.getByRole('button', { name: 'Invia notifica di prova' })).toBeInTheDocument();
  });
  it('handles denied permission and provider-disabled configuration', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    render(<MemoryRouter><PushSettings /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Attiva notifiche' })).toBeDisabled();
    expect(screen.getByText(/Notifiche bloccate/)).toBeInTheDocument();
  });
  it('does not attach activation to an account that changed while permission was pending', async () => {
    let resolve!: (id: string) => void;
    vi.mocked(client.enableDevicePush).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<MemoryRouter><PushSettings /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Attiva notifiche' }));
    await act(async () => { useAuthStore.setState({ user: { ...user, id: 'other' } }); resolve('old-device'); });
    await waitFor(() => expect(client.clearLocalPush).toHaveBeenCalled());
    expect(client.savePushPreferences).not.toHaveBeenCalled();
  });
  it('offers activation again when a provider has expired the subscription', async () => {
    vi.mocked(client.browserSubscription).mockResolvedValueOnce({ endpoint: 'https://fcm.googleapis.com/send/test' } as PushSubscription);
    vi.mocked(client.getDeviceSubscriptions).mockResolvedValueOnce([{ id: 'device-id', endpoint: 'https://fcm.googleapis.com/send/test' }]);
    vi.mocked(client.sendPushTest).mockRejectedValueOnce(new ApiClientError(410, 'push_subscription_expired', 'Expired'));
    render(<MemoryRouter><PushSettings /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Invia notifica di prova' }));
    expect(await screen.findByText('L’iscrizione è scaduta. Attiva di nuovo le notifiche su questo dispositivo.')).toBeVisible();
    expect(client.clearLocalPush).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Attiva notifiche' })).toBeEnabled();
  });

});
