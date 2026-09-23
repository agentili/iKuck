import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const verifiedSession = {
  authenticated: true,
  user: { id: 'a11y-user', email: 'a11y@example.com', emailVerifiedAt: '2026-09-15T08:00:00.000Z' },
  csrfToken: 'a11y-csrf',
  expiresAt: '2026-10-15T08:00:00.000Z',
};

const auditPage = async (page: Page, pageName: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const blockingViolations = results.violations.filter((violation) => (
    violation.impact === 'critical' || violation.impact === 'serious'
  ));

  expect(blockingViolations, `${pageName} has blocking accessibility violations`).toEqual([]);
};

const installVerifiedBackend = async (page: Page): Promise<void> => {
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { json: verifiedSession },
      'GET /v1/profile': { json: { profile: { displayName: 'A11y' } } },
      'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
      'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: null } } },
      'GET /v1/ai-recipes': { json: { recipes: [] } },
    },
  });
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('guest home passes the critical and serious axe gate', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa cuciniamo oggi?' })).toBeVisible();
  await auditPage(page, 'guest home');
});

test('verified home passes the critical and serious axe gate', async ({ page }) => {
  await installVerifiedBackend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa cuciniamo oggi?' })).toBeVisible();
  await auditPage(page, 'verified home');
});

test('pantry passes the critical and serious axe gate', async ({ page }) => {
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await auditPage(page, 'pantry');
});

test('profile passes the critical and serious axe gate', async ({ page }) => {
  await installVerifiedBackend(page);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  await auditPage(page, 'profile');
});

test('shopping list passes the critical and serious axe gate', async ({ page }) => {
  await page.goto('/shopping-list');
  await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  await auditPage(page, 'shopping list');
});

test('activity passes the critical and serious axe gate', async ({ page }) => {
  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'La tua attività' })).toBeVisible();
  await auditPage(page, 'activity');
});

test('recipe detail passes the critical and serious axe gate', async ({ page }) => {
  await page.goto('/recipes/pasta-tonno-pomodoro');
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await auditPage(page, 'recipe detail');
});

test('keeps focus indicators visible for links, controls and summaries', async ({ page }) => {
  await page.goto('/shopping-list');

  const focusableSelectors = [
    page.getByRole('link', { name: 'Home' }),
    page.getByLabel('Cosa ti serve?'),
    page.getByRole('button', { name: 'Aggiungi alla lista' }),
    page.getByText('Aggiungi dettagli (facoltativi)'),
  ];

  for (const locator of focusableSelectors) {
    const focusStyle = await locator.evaluate((element) => {
      element.focus();
      const style = window.getComputedStyle(element);
      return { outlineColor: style.outlineColor, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineWidth).not.toBe('0px');
    expect(focusStyle.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
  }
});

test('supports a 320px viewport and a 200% text-zoom equivalent without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(narrowOverflow).toBe(false);

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(zoomOverflow).toBe(false);

  const zoomNavigationBox = await page.getByRole('navigation', { name: 'Navigazione principale' }).boundingBox();
  expect(zoomNavigationBox).not.toBeNull();
  expect(zoomNavigationBox!.height).toBeLessThanOrEqual(144);
});

test('keeps pantry recipe action compact at 200% text zoom', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/pantry');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const recipeAction = page.getByRole('link', { name: 'Vai alle ricette' });
  await recipeAction.scrollIntoViewIfNeeded();
  const recipeActionBox = await recipeAction.boundingBox();

  expect(recipeActionBox).not.toBeNull();
  expect(recipeActionBox!.height).toBeLessThanOrEqual(128);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('keeps primary navigation fixed and touch-friendly on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/recipes/pasta-tonno-pomodoro');
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  expect(await navigation.evaluate((element) => window.getComputedStyle(element).position)).toBe('fixed');

  for (const name of ['Home', 'Dispensa', 'Lista', 'Attività', 'Profilo']) {
    const box = await navigation.getByRole('link', { name }).boundingBox();
    expect(box, `${name} should have a measurable touch target`).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(navigationBox!.y).toBeGreaterThanOrEqual(0);
  expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(844);
});

test('keeps common mobile actions comfortably tappable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/pantry');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  const removeIngredientBox = await page.getByRole('button', { name: 'Rimuovi Pasta' }).boundingBox();
  expect(removeIngredientBox).not.toBeNull();
  expect(removeIngredientBox!.width).toBeGreaterThanOrEqual(44);
  expect(removeIngredientBox!.height).toBeGreaterThanOrEqual(44);

  await page.goto('/shopping-list');
  const detailsBox = await page.getByText('Aggiungi dettagli (facoltativi)').boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox!.height).toBeGreaterThanOrEqual(44);

  await page.goto('/profile');
  const backBox = await page.getByRole('link', { name: /Torna alle ricette/ }).boundingBox();
  expect(backBox).not.toBeNull();
  expect(backBox!.height).toBeGreaterThanOrEqual(44);
});

test('respects reduced motion, heading order and icon-only accessible names', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/recipes/pasta-tonno-pomodoro');

  const transitionDuration = await page.getByRole('link', { name: 'Home' }).evaluate((element) => (
    window.getComputedStyle(element).transitionDuration
  ));
  expect(transitionDuration).toBe('0s');

  const headingLevels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((elements) => (
    elements.map((element) => Number(element.tagName.slice(1)))
  ));
  expect(headingLevels[0]).toBe(1);
  for (let index = 1; index < headingLevels.length; index += 1) {
    expect(headingLevels[index] - headingLevels[index - 1]).toBeLessThanOrEqual(1);
  }

  const unnamedIconButtons = await page.locator('button').evaluateAll((buttons) => buttons
    .filter((button) => button.textContent?.trim() === '')
    .filter((button) => (button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '').trim() === '')
    .map((button) => button.outerHTML));
  expect(unnamedIconButtons).toEqual([]);
});
