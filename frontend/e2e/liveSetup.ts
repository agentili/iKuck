const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export default async function globalSetup(): Promise<void> {
  const apiURL = process.env.E2E_API_URL?.trim() || process.env.E2E_BASE_URL?.trim();
  if (apiURL === undefined) {
    throw new Error('E2E_BASE_URL or E2E_API_URL is required for live-stack E2E tests');
  }

  const healthURL = new URL('/healthz', apiURL).toString();
  let lastFailure = 'no response';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(healthURL, { signal: AbortSignal.timeout(2000) });
      const payload = await response.json() as { status?: unknown };
      if (response.ok && payload.status === 'ok') return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : 'unknown error';
    }
    await wait(1000);
  }

  throw new Error(`Live-stack backend health check failed at ${healthURL}: ${lastFailure}`);
}
