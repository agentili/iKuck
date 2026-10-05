import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { createDrizzleS2sRepository } from './repository.js';
import { S2S_SERVICE_ID } from './constants.js';

type Repository = Pick<ReturnType<typeof createDrizzleS2sRepository>, 'createGrant' | 'issueOrRotate' | 'revoke' | 'reconcileCredential'>;
type Output = { stdout: (text: string) => void; stderr: (text: string) => void };
type Deps = { repository: Repository; output: Output; now?: () => number };
const usage = 's2s-admin provision --service ID --house ID --sponsor-user ID --sponsor-membership ID --out FILE | rotate --grant ID --out FILE [--expires-in-days N] | revoke --grant ID | recover --file FILE';
class CredentialRecoveryIncompleteError extends Error {
  constructor() {
    super('credential_recovery_incomplete');
    this.name = 'CredentialRecoveryIncompleteError';
  }
}
const parse = (args: string[]) => {
  const [command, ...rest] = args;
  if (!['provision', 'rotate', 'revoke', 'recover'].includes(command ?? '')) throw new Error(usage);
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--') || options[key.slice(2)]) throw new Error(usage);
    options[key.slice(2)] = rest[++i];
  }
  const allowed = command === 'provision' ? ['service', 'house', 'sponsor-user', 'sponsor-membership', 'out'] : command === 'rotate' ? ['grant', 'out', 'expires-in-days'] : command === 'revoke' ? ['grant'] : ['file'];
  const required = command === 'provision' ? ['service', 'house', 'sponsor-user', 'sponsor-membership', 'out'] : command === 'rotate' ? ['grant', 'out'] : command === 'revoke' ? ['grant'] : ['file'];
  if (Object.keys(options).some((key) => !allowed.includes(key)) || required.some((key) => !options[key])) throw new Error(usage);
  return { command: command as 'provision' | 'rotate' | 'revoke' | 'recover', options };
};
const makeCredential = () => ({ keyId: randomBytes(18).toString('base64url'), secret: randomBytes(32).toString('base64url') });
const assertPrivateDirectory = async (directoryPath: string) => {
  const directory = await lstat(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error('credential_directory_not_private');
};
const assertPrivateFile = async (file: string) => {
  let stat;
  try { stat = await lstat(file); }
  catch { throw new Error('credential_file_unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('credential_file_not_private');
};
const syncDirectory = async (directoryPath: string) => {
  const handle = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { await handle.sync(); }
  finally { await handle.close(); }
};
const replacePrivateFile = async (file: string, content: string) => {
  const target = resolve(file);
  const directoryPath = dirname(target);
  await assertPrivateDirectory(directoryPath);
  await assertPrivateFile(target);
  const temporary = resolve(directoryPath, `.${basename(target)}.${randomBytes(18).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, target);
    await syncDirectory(directoryPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};
const removePrivateFile = async (file: string) => {
  const target = resolve(file);
  const directoryPath = dirname(target);
  await assertPrivateDirectory(directoryPath);
  await assertPrivateFile(target);
  await unlink(target);
  await syncDirectory(directoryPath);
};
const saveOnce = async (file: string, content: string) => {
  const target = resolve(file);
  const directoryPath = dirname(target);
  await assertPrivateDirectory(directoryPath);
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(content, { encoding: 'utf8' }); await handle.sync(); }
  catch (error) { await handle.close().catch(() => undefined); await unlink(target).catch(() => undefined); throw error; }
  await handle.close();
  await syncDirectory(directoryPath);
  return target;
};
const recoverSavedCredential = async (file: string, deps: Deps): Promise<number> => {
  const target = resolve(file);
  await assertPrivateDirectory(dirname(target));
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => { throw new Error('credential_file_unavailable'); });
  let saved: { keyId?: unknown; token?: unknown; outcome?: unknown };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('credential_file_not_private');
    try { saved = JSON.parse(await handle.readFile('utf8')) as typeof saved; }
    catch { throw new Error('invalid_recovery_file'); }
  } finally { await handle.close(); }
  if (saved.outcome !== 'unknown' && saved.outcome !== 'pending') throw new Error('credential_not_recoverable');
  if (typeof saved.keyId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(saved.keyId) || typeof saved.token !== 'string') throw new Error('invalid_recovery_file');
  const [tokenKeyId, secret, extra] = saved.token.split('.');
  if (extra !== undefined || tokenKeyId !== saved.keyId || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('invalid_recovery_file');
  const reconciled = await deps.repository.reconcileCredential(saved.keyId, secret);
  if (!reconciled) {
    await replacePrivateFile(target, JSON.stringify({ keyId: saved.keyId, token: saved.token, outcome: 'unknown' }) + '\n');
    deps.output.stdout(`No committed credential found for ${saved.keyId}; private file retained for safe retry.\\n`);
    throw new CredentialRecoveryIncompleteError();
  }
  if (!reconciled.active) {
    await replacePrivateFile(target, JSON.stringify({ keyId: saved.keyId, grantId: reconciled.grantId, expiresAt: reconciled.expiresAt.toISOString(), outcome: 'inactive' }) + '\n');
    throw new Error('credential_not_active_after_reconciliation');
  }
  await replacePrivateFile(target, JSON.stringify({ keyId: saved.keyId, token: saved.token, grantId: reconciled.grantId, expiresAt: reconciled.expiresAt.toISOString(), outcome: 'active' }) + '\n');
  deps.output.stdout(`Grant ${reconciled.grantId}; credential recovered at ${target}.\\n`);
  return 0;
};
export const executeS2sAdmin = async (args: string[], deps: Deps): Promise<number> => {
  const { command, options } = parse(args);
  if (command === 'recover') return recoverSavedCredential(options.file, deps);
  if (command === 'provision' && options.service !== S2S_SERVICE_ID) throw new Error('invalid_service_id');
  const now = deps.now?.() ?? Date.now();
  if (command === 'revoke') { await deps.repository.revoke(options.grant); deps.output.stdout('Grant revoked.\\n'); return 0; }
  const days = options['expires-in-days'] === undefined ? 90 : Number(options['expires-in-days']);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('invalid_expiration_days');
  const expiresAt = new Date(now + days * 86400000);
  const { keyId, secret } = makeCredential();
  const file = await saveOnce(options.out, JSON.stringify({ keyId, token: `${keyId}.${secret}`, requestedExpiresAt: expiresAt.toISOString(), ...(command === 'rotate' ? { grantId: options.grant } : {}), outcome: 'pending' }) + '\n');
  const recoverAmbiguousCommit = async (cause: unknown): Promise<number> => {
    let reconciled: Awaited<ReturnType<Repository['reconcileCredential']>>;
    try { reconciled = await deps.repository.reconcileCredential(keyId, secret); }
    catch {
      await replacePrivateFile(file, JSON.stringify({ keyId, token: `${keyId}.${secret}`, ...(command === 'rotate' ? { grantId: options.grant } : {}), requestedExpiresAt: expiresAt.toISOString(), outcome: 'unknown' }) + '\n').catch(() => undefined);
      throw cause;
    }
    if (!reconciled) {
      await removePrivateFile(file).catch(async () => {
        await replacePrivateFile(file, JSON.stringify({ keyId, outcome: 'rolled_back' }) + '\n').catch(() => undefined);
      });
      throw cause;
    }
    if (!reconciled.active) {
      await replacePrivateFile(file, JSON.stringify({ keyId, grantId: reconciled.grantId, expiresAt: reconciled.expiresAt.toISOString(), outcome: 'inactive' }) + '\n');
      throw new Error('credential_not_active_after_reconciliation');
    }
    await replacePrivateFile(file, JSON.stringify({ keyId, token: `${keyId}.${secret}`, grantId: reconciled.grantId, expiresAt: reconciled.expiresAt.toISOString(), outcome: 'active' }) + '\n');
    deps.output.stdout(`Grant ${reconciled.grantId}; credential written once to ${file} (reconciled).\\n`);
    return 0;
  };
  let grantId: string;
  let effectiveExpiry: Date;
  try {
    if (command === 'provision') {
      const grant = await deps.repository.createGrant({ serviceId: options.service, houseId: options.house, sponsorUserId: options['sponsor-user'], sponsorMembershipId: options['sponsor-membership'], expiresAt, keyId, secret, credentialExpiresAt: expiresAt });
      grantId = grant.id;
      effectiveExpiry = grant.expiresAt;
    } else {
      const grant = await deps.repository.issueOrRotate(options.grant, keyId, secret, expiresAt);
      grantId = options.grant;
      effectiveExpiry = grant.expiresAt;
    }
  } catch (error) { return recoverAmbiguousCommit(error); }
  await replacePrivateFile(file, JSON.stringify({ keyId, token: `${keyId}.${secret}`, grantId, expiresAt: effectiveExpiry.toISOString(), outcome: 'active' }) + '\n');
  deps.output.stdout(`Grant ${grantId}; credential written once to ${file}.\\n`);
  return 0;
};

export const runS2sAdminWithDeadline = async <T>(operation: () => Promise<T>, terminateDatabase: () => Promise<unknown>, timeoutMs = 30_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(operation);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { void Promise.resolve(terminateDatabase()).catch(() => undefined); }
      catch { /* report the operation deadline regardless of pool termination failure */ }
      reject(new Error('s2s_admin_deadline_exceeded'));
    }, timeoutMs);
  });
  try { return await Promise.race([running, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
};

const run = async () => {
  const database = createDatabase(loadConfig(process.env).databaseUrl, { max: 1, connectTimeoutSeconds: 5 });
  try {
    await runS2sAdminWithDeadline(
      () => executeS2sAdmin(process.argv.slice(2), { repository: createDrizzleS2sRepository(database.db), output: { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) } }),
      () => database.db.$client.end({ timeout: 0 }),
    );
  } catch (error) {
    process.stderr.write(error instanceof Error && ['credential_directory_not_private', 'credential_file_unavailable', 'credential_file_not_private', 'credential_not_recoverable', 'credential_not_active_after_reconciliation', 'credential_recovery_incomplete', 'invalid_recovery_file', 'invalid_expiration_days', 'invalid_service_id', 's2s_admin_pool_acquire_timeout', 's2s_admin_deadline_exceeded'].includes(error.message) ? `${error.message}\n` : 'S2S administrative operation failed.\n');
    process.exitCode = 1;
  } finally { await database.close(); }
};
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void run();
