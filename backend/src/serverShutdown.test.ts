import { describe, expect, it } from 'vitest';
import { closeServerResources } from './serverShutdown.js';

describe('closeServerResources', () => {
  it('waits for the HTTP server to finish before closing dependencies', async () => {
    const events: string[] = [];
    let releaseAppClose!: () => void;
    let signalAppCloseStarted!: () => void;
    const appCloseGate = new Promise<void>((resolve) => { releaseAppClose = resolve; });
    const appCloseStarted = new Promise<void>((resolve) => { signalAppCloseStarted = resolve; });
    const shutdown = closeServerResources(async () => {
      events.push('app-close-start');
      signalAppCloseStarted();
      await appCloseGate;
      events.push('app-close-done');
    }, [async () => { events.push('dependency-close'); }], () => { events.push('unexpected-force-close'); });

    await appCloseStarted;
    expect(events).toEqual(['app-close-start']);
    releaseAppClose();
    await shutdown;
    expect(events).toEqual(['app-close-start', 'app-close-done', 'dependency-close']);
  });

  it('force-closes the HTTP server after the drain deadline before dependency shutdown', async () => {
    const events: string[] = [];
    let releaseAppClose!: () => void;
    let signalForcedClose!: () => void;
    const appCloseGate = new Promise<void>((resolve) => { releaseAppClose = resolve; });
    const forcedClose = new Promise<void>((resolve) => { signalForcedClose = resolve; });
    const shutdown = closeServerResources(async () => {
      events.push('app-close-start');
      await appCloseGate;
      events.push('app-close-done');
    }, [async () => { events.push('dependency-close'); }], () => {
      events.push('force-close');
      signalForcedClose();
      releaseAppClose();
    }, 5);
    const forcedInTime = await Promise.race([forcedClose.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
    if (!forcedInTime) releaseAppClose();
    await shutdown;
    expect(forcedInTime).toBe(true);
    expect(events).toEqual(['app-close-start', 'force-close', 'app-close-done', 'dependency-close']);
  });

  it('attempts every dependency even when app or another resource close rejects', async () => {
    const events: string[] = [];
    await closeServerResources(async () => { events.push('app-close'); throw new Error('app close failed'); }, [
      async () => { events.push('first-dependency'); throw new Error('first close failed'); },
      async () => { events.push('second-dependency'); },
    ], () => { events.push('force-close'); });
    expect(events).toEqual(['app-close', 'force-close', 'first-dependency', 'second-dependency']);
  });
});
