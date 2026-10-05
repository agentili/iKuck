export type CloseOperation = () => Promise<unknown>;

const waitForSettlement = async (operation: Promise<unknown>, timeoutMs: number): Promise<'fulfilled' | 'rejected' | 'timed_out'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    operation.then(() => 'fulfilled' as const, () => 'rejected' as const),
    new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
};

export const closeServerResources = async (
  closeApp: CloseOperation,
  closeDependencies: readonly CloseOperation[],
  forceCloseApp: () => void,
  drainTimeoutMs = 10_000,
) => {
  const appClose = Promise.resolve().then(closeApp);
  const drained = await waitForSettlement(appClose, drainTimeoutMs);
  if (drained !== 'fulfilled') {
    try { forceCloseApp(); } catch { /* still close owned resources after an unsuccessful drain */ }
    if (drained === 'timed_out') await waitForSettlement(appClose, 1_000);
  }
  await Promise.allSettled(closeDependencies.map((close) => Promise.resolve().then(close)));
};
