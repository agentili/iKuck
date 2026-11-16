// Writes cannot postpone the periodic pull or bypass backoff.
export function createSyncScheduler(run: () => Promise<boolean>, canRun: () => boolean) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let failures = 0;
  let retryAt = 0;
  let dueAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number): void => {
    if (stopped || running) return;
    const due = Math.max(Date.now() + delay, retryAt);
    if (timer !== undefined && dueAt <= due) return;
    clearTimeout(timer);
    dueAt = due;
    timer = setTimeout(() => { timer = undefined; void tick(); }, due - Date.now());
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!canRun()) { schedule(30_000); return; }
    running = true;
    dirty = false;
    let success = false;
    try { success = await run(); } catch { /* Transport and storage failures both need retry. */ }
    running = false;
    if (stopped) return;
    failures = success ? 0 : Math.min(failures + 1, 7);
    retryAt = success ? 0 : Date.now() + Math.min(60_000, 1_000 * 2 ** (failures - 1));
    schedule(success ? (dirty ? 250 : 30_000) : 0);
  };
  schedule(30_000);
  return {
    request: () => { dirty = true; schedule(250); },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}
