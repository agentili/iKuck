import { mkdtemp, readFile, writeFile, rm, chmod, lstat, link, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeS2sAdmin, runS2sAdminWithDeadline } from './adminCli.js';
import { S2S_SERVICE_ID } from './constants.js';

const dirs: string[] = [];
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ikuck-s2s-'));
  dirs.push(dir);
  const output = { stdout: '', stderr: '' };
  const sink = { stdout: (text: string) => { output.stdout += text; }, stderr: (text: string) => { output.stderr += text; } };
  const repo = {
    createGrant: vi.fn(async () => ({ id: 'grant-synthetic', expiresAt: new Date(1_800_000_000_000 + 90 * 86400000) })),
    issueOrRotate: vi.fn(async () => ({ expiresAt: new Date(1_800_000_000_000 + 90 * 86400000) })),
    reconcileCredential: vi.fn(async () => null as null | { grantId: string; expiresAt: Date; active: boolean }),
    revoke: vi.fn(async () => undefined),
  };
  return { dir, output, sink, repo };
};
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('S2S administrative CLI', () => {
  it('terminates the private database pool when the total operation deadline expires', async () => {
    let finishOperation!: () => void;
    let terminated = 0;
    const operation = new Promise<void>((resolve) => { finishOperation = resolve; });
    await expect(runS2sAdminWithDeadline(() => operation, async () => { terminated += 1; }, 5)).rejects.toThrow('s2s_admin_deadline_exceeded');
    expect(terminated).toBe(1);
    finishOperation();
  });

  it('provisions sponsor-bound grant and delivers a credential once in an exclusive 0600 file', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'house-x', '--sponsor-user', 'user-x', '--sponsor-membership', 'member-x', '--out', path], { repository: repo, output: sink, now: () => 1_800_000_000_000 })).resolves.toBe(0);
    const credential = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; grantId: string };
    expect(credential.grantId).toBe('grant-synthetic');
    expect(credential.keyId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(repo.createGrant).toHaveBeenCalledWith(expect.objectContaining({ sponsorUserId: 'user-x', sponsorMembershipId: 'member-x', secret: credential.token.split('.')[1] }));
    expect(repo.createGrant).toHaveBeenCalledWith(expect.objectContaining({ serviceId: S2S_SERVICE_ID }));
    expect(output.stdout).toContain('grant-synthetic');
    expect(output.stdout + output.stderr).not.toContain(credential.token);
  });

  it('atomically replaces a pending credential file after a committed provision', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const retainedPending = join(dir, 'pending-inode.json');
    repo.createGrant.mockImplementationOnce(async () => {
      await link(path, retainedPending);
      return { id: 'grant-atomic', expiresAt: new Date(Date.now() + 60_000) };
    });
    await executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'house-x', '--sponsor-user', 'user-x', '--sponsor-membership', 'member-x', '--out', path], { repository: repo, output: sink });
    expect(JSON.parse(await readFile(retainedPending, 'utf8'))).toMatchObject({ outcome: 'pending' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ grantId: 'grant-atomic', outcome: 'active' });
    expect((await lstat(path)).ino).not.toBe((await lstat(retainedPending)).ino);
  });

  it('does not follow a recovery path replaced by a symlink after validation', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const protectedTarget = join(dir, 'target.json');
    const keyId = 'D'.repeat(18);
    const token = `${keyId}.${'s'.repeat(43)}`;
    await writeFile(path, JSON.stringify({ keyId, token, outcome: 'unknown' }), { mode: 0o600 });
    await writeFile(protectedTarget, 'sentinel', { mode: 0o600 });
    repo.reconcileCredential.mockImplementationOnce(async () => {
      await unlink(path);
      await symlink(protectedTarget, path);
      return { grantId: 'grant-recovered', expiresAt: new Date(Date.now() + 60_000), active: true };
    });
    await expect(executeS2sAdmin(['recover', '--file', path], { repository: repo, output: sink })).rejects.toThrow();
    expect(await readFile(protectedTarget, 'utf8')).toBe('sentinel');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it.each(['provision', 'rotate'] as const)('writes the repository-bounded expiry for %s', async (command) => {
    const { dir, sink, repo } = await setup();
    const now = 1_800_000_000_000;
    const effectiveExpiry = new Date(now + 15 * 86400000);
    const path = join(dir, 'credential.json');
    if (command === 'provision') repo.createGrant.mockResolvedValueOnce({ id: 'grant-bounded', expiresAt: effectiveExpiry });
    else repo.issueOrRotate.mockResolvedValueOnce({ expiresAt: effectiveExpiry });
    const args = command === 'provision'
      ? ['provision', '--service', S2S_SERVICE_ID, '--house', 'house-x', '--sponsor-user', 'user-x', '--sponsor-membership', 'member-x', '--out', path]
      : ['rotate', '--grant', 'grant-existing', '--out', path];
    await expect(executeS2sAdmin(args, { repository: repo, output: sink, now: () => now })).resolves.toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ expiresAt: effectiveExpiry.toISOString(), outcome: 'active' });
  });

  it('rejects an unsupported service before creating a credential file or calling the repository', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    await expect(executeS2sAdmin(['provision', '--service', 'dinner', '--house', 'h', '--sponsor-user', 'u', '--sponsor-membership', 'm', '--out', path], { repository: repo, output: sink })).rejects.toThrow('invalid_service_id');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repo.createGrant).not.toHaveBeenCalled();
  });

  it('does not persist a grant when exclusive credential delivery fails', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'present');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, 'sentinel'));
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'h', '--sponsor-user', 'u', '--sponsor-membership', 'm', '--out', path], { repository: repo, output: sink })).rejects.toThrow();
    expect(repo.createGrant).not.toHaveBeenCalled();
  });

  it('recovers a committed provision when the database acknowledgement was lost', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const effectiveExpiry = new Date(Date.now() + 60_000);
    repo.createGrant.mockRejectedValueOnce(new Error('commit acknowledgement lost'));
    repo.reconcileCredential.mockResolvedValueOnce({ grantId: 'grant-recovered', expiresAt: effectiveExpiry, active: true });
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'house-x', '--sponsor-user', 'user-x', '--sponsor-membership', 'member-x', '--out', path], { repository: repo, output: sink })).resolves.toBe(0);
    const credential = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; grantId: string; expiresAt: string; outcome: string };
    expect(credential).toMatchObject({ grantId: 'grant-recovered', expiresAt: effectiveExpiry.toISOString(), outcome: 'active' });
    expect(repo.reconcileCredential).toHaveBeenCalledWith(credential.keyId, credential.token.split('.')[1]);
    expect(output.stdout).toContain('grant-recovered');
    expect(output.stdout + output.stderr).not.toContain(credential.token);
  });

  it('recovers a committed rotation when the database acknowledgement was lost', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'rotated.json');
    const effectiveExpiry = new Date(Date.now() + 60_000);
    repo.issueOrRotate.mockRejectedValueOnce(new Error('commit acknowledgement lost'));
    repo.reconcileCredential.mockResolvedValueOnce({ grantId: 'grant-existing', expiresAt: effectiveExpiry, active: true });
    await expect(executeS2sAdmin(['rotate', '--grant', 'grant-existing', '--out', path], { repository: repo, output: sink })).resolves.toBe(0);
    const credential = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; grantId: string; expiresAt: string; outcome: string };
    expect(credential).toMatchObject({ grantId: 'grant-existing', expiresAt: effectiveExpiry.toISOString(), outcome: 'active' });
    expect(repo.reconcileCredential).toHaveBeenCalledWith(credential.keyId, credential.token.split('.')[1]);
    expect(output.stdout).toContain('grant-existing');
  });

  it('removes the provisional secret file after reconciliation confirms the transaction rolled back', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    repo.createGrant.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'h', '--sponsor-user', 'u', '--sponsor-membership', 'm', '--out', path], { repository: repo, output: sink })).rejects.toThrow('transaction failed');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the private credential file on ambiguous database failure for safe reconciliation', async () => {
    const { dir, output, sink, repo } = await setup();
    repo.createGrant.mockRejectedValueOnce(new Error('synthetic database failure'));
    repo.reconcileCredential.mockRejectedValueOnce(new Error('reconciliation unavailable'));
    const path = join(dir, 'credential.json');
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'h', '--sponsor-user', 'u', '--sponsor-membership', 'm', '--out', path], { repository: repo, output: sink })).rejects.toThrow();
    const saved = JSON.parse(await readFile(path, 'utf8')) as { keyId: string; token: string; outcome: string };
    expect(saved).toMatchObject({ outcome: 'unknown' });
    expect(repo.reconcileCredential).toHaveBeenCalledWith(saved.keyId, saved.token.split('.')[1]);
    expect(output.stdout + output.stderr).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('recovers a saved ambiguous credential without provisioning a second grant', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const keyId = 'A'.repeat(18);
    const token = `${keyId}.${'s'.repeat(43)}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await writeFile(path, JSON.stringify({ keyId, token, requestedExpiresAt: expiresAt.toISOString(), outcome: 'unknown' }), { mode: 0o600 });
    repo.reconcileCredential.mockResolvedValueOnce({ grantId: 'grant-recovered', expiresAt, active: true });
    await expect(executeS2sAdmin(['recover', '--file', path], { repository: repo, output: sink })).resolves.toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ keyId, token, grantId: 'grant-recovered', expiresAt: expiresAt.toISOString(), outcome: 'active' });
    expect(repo.reconcileCredential).toHaveBeenCalledWith(keyId, 's'.repeat(43));
    expect(output.stdout).toContain('grant-recovered');
    expect(output.stdout + output.stderr).not.toContain(token);
  });

  it('reports pending credential recovery as incomplete and retains the private file when no row is committed', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const keyId = 'P'.repeat(18);
    const token = `${keyId}.${'s'.repeat(43)}`;
    await writeFile(path, JSON.stringify({ keyId, token, requestedExpiresAt: new Date(Date.now() + 60_000).toISOString(), outcome: 'pending' }), { mode: 0o600 });
    repo.reconcileCredential.mockResolvedValueOnce(null);
    await expect(executeS2sAdmin(['recover', '--file', path], { repository: repo, output: sink })).rejects.toThrow('credential_recovery_incomplete');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ keyId, token, outcome: 'unknown' });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(output.stdout).toContain('retained for safe retry');
    expect(output.stdout + output.stderr).not.toContain(token);
  });

  it('reports ambiguous credential recovery as incomplete and retains the private file when no row is committed', async () => {
    const { dir, output, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const keyId = 'B'.repeat(18);
    const token = `${keyId}.${'s'.repeat(43)}`;
    await writeFile(path, JSON.stringify({ keyId, token, outcome: 'unknown' }), { mode: 0o600 });
    repo.reconcileCredential.mockResolvedValueOnce(null);
    await expect(executeS2sAdmin(['recover', '--file', path], { repository: repo, output: sink })).rejects.toThrow('credential_recovery_incomplete');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ keyId, token, outcome: 'unknown' });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(output.stdout + output.stderr).not.toContain(token);
  });

  it('keeps an ambiguous credential intact when recovery cannot reach the database', async () => {
    const { dir, sink, repo } = await setup();
    const path = join(dir, 'credential.json');
    const keyId = 'C'.repeat(18);
    const token = `${keyId}.${'s'.repeat(43)}`;
    await writeFile(path, JSON.stringify({ keyId, token, outcome: 'unknown' }), { mode: 0o600 });
    repo.reconcileCredential.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(executeS2sAdmin(['recover', '--file', path], { repository: repo, output: sink })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ keyId, token, outcome: 'unknown' });
  });

  it('rejects an unsafe credential directory without invoking repository', async () => {
    const { dir, sink, repo } = await setup();
    await chmod(dir, 0o777);
    const path = join(dir, 'credential.json');
    await expect(executeS2sAdmin(['provision', '--service', S2S_SERVICE_ID, '--house', 'h', '--sponsor-user', 'u', '--sponsor-membership', 'm', '--out', path], { repository: repo, output: sink })).rejects.toThrow();
    expect(repo.createGrant).not.toHaveBeenCalled();
  });
});
