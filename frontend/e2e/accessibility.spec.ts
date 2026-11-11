import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';
import {
  kitchenHeading,
  kitchenNavigationLabel,
  kitchenPath,
  landingHeading,
  openPantryInventory,
} from './helpers/appMode';

const themePreferenceKey = 'ikuck-color-theme';

const verifiedSession = {
  authenticated: true,
  user: { id: 'a11y-user', email: 'a11y@example.com', emailVerifiedAt: '2026-09-15T08:00:00.000Z' },
  csrfToken: 'a11y-csrf',
  expiresAt: '2026-10-15T08:00:00.000Z',
};

const verifiedResponses: Record<string, OfflineApiResponse> = {
  'GET /v1/auth/session': { json: verifiedSession },
  'GET /v1/profile': { json: { profile: { displayName: 'A11y' } } },
  'GET /v1/house': { json: null },
  'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
  'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
  'GET /v1/ai-recipes/consent': {
    json: { consent: { enabled: false, updatedAt: '2026-09-18T10:00:00.000Z' }, selectedProvider: 'openai' },
  },
  'GET /v1/ai-recipes': { json: { recipes: [] } },
};

const installVerifiedBackend = async (page: Page, extraResponses: Record<string, OfflineApiResponse> = {}): Promise<void> => {
  await installOfflineBackend(page, { responses: { ...verifiedResponses, ...extraResponses } });
};

const auditPage = async (page: Page, pageName: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const blockingViolations = results.violations.filter((violation) => (
    violation.impact === 'critical' || violation.impact === 'serious'
  ));
  expect(blockingViolations, `${pageName} ha violazioni di accessibilità bloccanti`).toEqual([]);
};

type AuditedPage = {
  path: string;
  heading?: string;
  name: string;
  /** True quando la pagina richiede una sessione verificata (profilo, casa, diario). */
  auth: boolean;
};

const auditedPages: AuditedPage[] = [
  { path: '/', heading: landingHeading, name: 'chef', auth: false },
  { path: kitchenPath, heading: kitchenHeading, name: 'home', auth: false },
  { path: '/recipes', heading: 'Ricette', name: 'recipes-library', auth: false },
  { path: '/pantry', heading: 'La tua dispensa', name: 'pantry', auth: false },
  { path: '/plan', heading: 'Piano settimanale', name: 'plan', auth: false },
  { path: '/shopping-list', heading: 'Lista della spesa', name: 'shopping-list', auth: false },
  { path: '/activity', heading: 'La tua attività', name: 'activity', auth: false },
  { path: '/profile', heading: 'Il tuo profilo', name: 'profile', auth: true },
  // HousePage senza casa non rende un h1: si verifica la presenza del main.
  { path: '/house', name: 'house', auth: true },
  { path: '/recipes/pasta-tonno-pomodoro', heading: 'Pasta tonno e pomodoro', name: 'recipe-detail', auth: false },
] as const;

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`axe gate - tema ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((preference: string) => {
        localStorage.setItem(themePreferenceKey, preference);
      }, theme);
    });

    for (const pageDef of auditedPages) {
      test(`${pageDef.name} supera il gate axe`, async ({ page }) => {
        if (pageDef.auth) {
          await installVerifiedBackend(page);
        } else {
          await installOfflineBackend(page);
        }

        await page.goto(pageDef.path);
        if (pageDef.heading !== undefined) {
          const heading = pageDef.name === 'chef'
            ? page.locator('main').getByRole('heading', { name: pageDef.heading, exact: true })
            : page.getByRole('heading', { name: pageDef.heading, exact: true });
          await expect(heading).toBeVisible();
        } else {
          await expect(page.locator('main')).toBeVisible();
        }

        await auditPage(page, `${pageDef.name} [tema ${theme}]`);
      });
    }
  });
}

// Scenari di accessibilità esistenti (invarianze di interazione, temi e soglie di tocco).
test('guest home passes the critical and serious axe gate', async ({ page }) => {
  await page.goto(kitchenPath);
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();
  await auditPage(page, 'guest home');
});

test('verified home passes the critical and serious axe gate', async ({ page }) => {
  await installVerifiedBackend(page);
  await page.goto(kitchenPath);
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();
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

test('Bring connection form is labeled and accessible before credential entry', async ({ page }) => {
  await installVerifiedBackend(page, {
    'GET /v1/integrations/bring': { json: { enabled: true, connected: false, connectionId: null } },
  });
  await page.goto('/shopping-list');
  await page.getByRole('button', { name: 'Bring!', exact: true }).click();
  await expect(page.getByLabel('Email Bring!')).toBeVisible();
  await expect(page.getByLabel('Password Bring!')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collega Bring!', exact: true })).toBeDisabled();
  await auditPage(page, 'Bring connection form');

  const touchTargets = [
    page.getByLabel('Email Bring!'),
    page.getByLabel('Password Bring!'),
    page.getByRole('checkbox', { name: /Autorizzo iKuck ad accedere/ }).locator('xpath=..'),
    page.getByRole('button', { name: 'Collega Bring!', exact: true }),
  ];
  for (const target of touchTargets) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('Bring list actions pass axe and remain touch-friendly at 320px with 200% text', async ({ page }) => {
  const connectionId = '33333333-3333-4333-8333-333333333333';
  const listId = '22222222-2222-4222-8222-222222222222';
  await page.setViewportSize({ width: 320, height: 700 });
  await installVerifiedBackend(page, {
    'GET /v1/integrations/bring': { json: { enabled: true, connected: true, connectionId } },
    [`GET /v1/integrations/bring/lists?connectionId=${connectionId}`]: {
      json: { connectionId, lists: [{ id: listId, name: 'Casa' }] },
    },
    [`GET /v1/integrations/bring/items?connectionId=${connectionId}&listId=${listId}`]: {
      json: {
        connectionId,
        listId,
        labelsAvailable: true,
        items: [
          { name: 'Milch', label: 'Latte', specification: '1 l', state: 'purchase', mutable: true },
          { name: 'Brot', label: 'Pane', specification: '200 g', state: 'recently', mutable: true },
        ],
      },
    },
  });
  await page.goto('/shopping-list');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(page.getByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Lista Bring!' }).selectOption(listId);
  await expect(page.locator('[data-bring-name="Milch"]').getByText('Latte', { exact: true })).toBeVisible();
  await expect(page.locator('[data-bring-name="Brot"]').getByText('Pane', { exact: true })).toBeVisible();
  await auditPage(page, 'Bring remote list and actions at 320px/200% text');

  const touchTargets = [
    page.getByRole('button', { name: 'iKuck', exact: true }),
    page.getByRole('button', { name: 'Bring!', exact: true }),
    page.getByRole('button', { name: 'Scollega Bring!' }),
    page.getByRole('combobox', { name: 'Lista Bring!' }),
    page.getByLabel('Cosa aggiungere a Bring!'),
    page.getByLabel('Specifica Bring!'),
    page.getByRole('button', { name: 'Aggiungi a Bring!' }),
    page.getByRole('button', { name: 'Segna Latte acquistato su Bring!' }),
    page.getByRole('button', { name: 'Rimuovi Latte da Bring!' }),
    page.getByRole('button', { name: 'Ripristina Pane su Bring!' }),
    page.getByRole('button', { name: 'Rimuovi Pane da Bring!' }),
    page.locator('summary'),
  ];
  for (const target of touchTargets) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
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
    page.getByRole('link', { name: kitchenNavigationLabel, exact: true }),
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

test('Chef cooking destinations are keyboard reachable with visible focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: landingHeading, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Messaggio per Chef' })).toHaveCount(0);

  const shortcuts = page.getByRole('navigation', { name: 'Navigazione principale' });
  const pantryLink = shortcuts.getByRole('link', { name: /Dispensa/ });
  let pantryLinkReceivedKeyboardFocus = false;
  for (let step = 0; step < 30; step += 1) {
    if (await pantryLink.evaluate((element) => element === document.activeElement)) {
      pantryLinkReceivedKeyboardFocus = true;
      break;
    }
    await page.keyboard.press('Tab');
  }
  expect(pantryLinkReceivedKeyboardFocus, 'Tab deve raggiungere la voce Dispensa.').toBe(true);

  await expect(pantryLink).toBeFocused();
  const focusStyle = await pantryLink.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { outlineColor: style.outlineColor, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineWidth).not.toBe('0px');
  expect(focusStyle.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
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
  await openPantryInventory(page);

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

  const navigationLabels = ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette'];
  for (const name of navigationLabels) {
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

test('keeps mobile navigation labels concise and on one line', async ({ page }) => {
  const scenarios = [
    {
      width: 390,
      height: 844,
      zoom: false,
      labels: ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette'],
      accessibleNames: ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette'],
    },
    {
      width: 320,
      height: 700,
      zoom: true,
      labels: ['Disp.', 'Sp.', 'Chef', 'Pi.', 'Ric.'],
      accessibleNames: ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette'],
    },
  ];

  for (const scenario of scenarios) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto('/');
    if (scenario.zoom) {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    }

    const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
    await expect(navigation.getByRole('link')).toHaveCount(scenario.labels.length);
    const items = await navigation.getByRole('link').evaluateAll((links) => links.map((link) => {
      const visibleLabels = Array.from(link.querySelectorAll('span'))
        .filter((label) => label.querySelector('span') === null)
        .filter((label) => window.getComputedStyle(label).display !== 'none');
      const label = visibleLabels[0];
      if (label === undefined) return { label: '', wraps: true, accessibleName: link.getAttribute('aria-label') };
      const styles = window.getComputedStyle(label);
      const lineHeight = Number.parseFloat(styles.lineHeight);
      return {
        label: label.textContent?.trim() ?? '',
        wraps: label.scrollHeight > lineHeight * 1.5 || label.scrollWidth > label.clientWidth,
        metrics: {
          clientWidth: label.clientWidth,
          scrollWidth: label.scrollWidth,
          scrollHeight: label.scrollHeight,
          lineHeight,
        },
        accessibleName: link.getAttribute('aria-label'),
      };
    }));

    expect(items.map((item) => item.label)).toEqual(scenario.labels);
    expect(items.every((item) => !item.wraps), JSON.stringify(items)).toBe(true);
    expect(items.map((item) => item.accessibleName)).toEqual(scenario.accessibleNames);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  }
});

test('keeps common mobile actions comfortably tappable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/pantry');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await openPantryInventory(page);
  const removeIngredientBox = await page.getByRole('button', { name: 'Rimuovi Pasta' }).boundingBox();
  expect(removeIngredientBox).not.toBeNull();
  expect(removeIngredientBox!.width).toBeGreaterThanOrEqual(44);
  expect(removeIngredientBox!.height).toBeGreaterThanOrEqual(44);

  await page.goto('/shopping-list');
  const detailsBox = await page.getByText('Aggiungi dettagli (facoltativi)').boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox!.height).toBeGreaterThanOrEqual(44);

  await page.goto('/profile');
  const backLinkName = /Torna a Chef/;
  const backBox = await page.getByRole('link', { name: backLinkName }).boundingBox();
  expect(backBox).not.toBeNull();
  expect(backBox!.height).toBeGreaterThanOrEqual(44);
});

test('respects reduced motion, heading order and icon-only accessible names', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/recipes/pasta-tonno-pomodoro');

  const kitchenNavigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const transitionDuration = await kitchenNavigation.getByRole('link', { name: kitchenNavigationLabel }).evaluate((element) => (
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
