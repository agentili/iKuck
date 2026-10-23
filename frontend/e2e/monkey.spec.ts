import { expect, test } from '@playwright/test';
import { installPermissiveBackend, monkeyExplore } from './helpers/monkey';

test.setTimeout(120000);

test('esplorazione casuale monkey: nessuna eccezione JavaScript non gestita, nessuna pagina bianca', async ({ page }) => {
  await installPermissiveBackend(page);

  const report = await monkeyExplore(page, { iterations: 50, startUrl: '/' });

  await test.info().attach('monkey-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  expect(report.visitedUrls.length).toBeGreaterThanOrEqual(1);
  expect(report.jsErrors).toEqual([]);
  expect(report.networkErrors).toEqual([]);
});
