import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';

test.skip(process.env.IKUCK_MEAL_PLAN_DISPOSABLE !== 'true', 'Requires dedicated PostgreSQL/Redis and a disposable API');
test.skip(process.env.IKUCK_PLAN_WIZARD_FAKE_AI !== 'true', 'Requires the explicitly enabled fake AI fixture; never call a real provider');
const origin = 'http://127.0.0.1:5173';
interface Session { user: { id: string; email: string }; csrfToken: string }

async function register(context: BrowserContext): Promise<Session> {
  const email = `wizard-${randomUUID()}@example.test`;
  const password = 'disposable-wizard-password';
  const response = await context.request.post(`${origin}/v1/auth/register`, { headers: { origin }, data: { email, password } });
  expect(response.status()).toBe(202);
  const login = await context.request.post(`${origin}/v1/auth/login`, { headers: { origin }, data: { email, password } });
  expect(login.status()).toBe(200);
  return login.json() as Promise<Session>;
}

test('condivide la ricetta confermata e il giorno con un secondo membro della Casa', async ({ browser }) => {
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await browser.newContext();
  try {
    const ownerSession = await register(owner);
    const memberSession = await register(member);
    const headers = { origin, 'x-csrf-token': ownerSession.csrfToken };
    const house = await owner.request.post(`${origin}/v1/house`, { headers, data: { name: 'Casa wizard disposable' } });
    expect(house.status()).toBe(201);
    const invited = await owner.request.post(`${origin}/v1/house/members`, { headers, data: { email: memberSession.user.email } });
    expect(invited.status()).toBe(201);
    const consentStatus = await owner.request.get(`${origin}/v1/ai-recipes/consent`);
    expect(consentStatus.status()).toBe(200);
    const status = await consentStatus.json() as { consent: { updatedAt: string }; selectedProvider: string };
    const consent = await owner.request.put(`${origin}/v1/ai-recipes/consent`, {
      headers, data: { enabled: true, homeProvider: status.selectedProvider, expectedRevision: status.consent.updatedAt },
    });
    expect(consent.status()).toBe(200);

    const page = await owner.newPage();
    await page.goto('/plan');
    const row = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
    const date = await row.getAttribute('data-date');
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await row.getByRole('button', { name: /cambia ricetta/i }).click();
    const wizard = page.getByRole('dialog', { name: 'Definisci la ricetta del giorno' });
    await wizard.getByRole('button', { name: /crea con ai/i }).click();
    await wizard.getByLabel('Descrizione del piatto', { exact: true }).fill('Riso al limone per la Casa');
    await wizard.getByLabel('Numero di porzioni').fill('4');
    await wizard.getByRole('button', { name: 'Genera ricetta AI' }).click();
    const proposedTitle = wizard.getByRole('heading', { level: 3 });
    await expect(proposedTitle).toBeVisible();
    const title = (await proposedTitle.textContent())!;
    await expect(row.getByText(title, { exact: true })).toHaveCount(0);
    await wizard.getByRole('button', { name: 'Salva nel ricettario e usa' }).click();
    await expect(wizard).toHaveCount(0);
    await expect(row.getByText(title, { exact: true })).toBeVisible();
    await expect(row.getByText('In attesa di conferma · non condivisa', { exact: true })).toHaveCount(0);

    const memberPage = await member.newPage();
    await memberPage.goto('/plan');
    const sharedRow = memberPage.locator(`[data-date="${date}"]`);
    await expect(sharedRow.getByText(title, { exact: true })).toBeVisible();
    await memberPage.reload();
    await expect(sharedRow.getByText(title, { exact: true })).toBeVisible();
    await memberPage.goto('/recipes');
    await expect(memberPage.getByText(title, { exact: true })).toBeVisible();
    await page.reload();
    await expect(row.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Stato della condivisione' })).toHaveCount(0);
  } finally {
    await Promise.all([owner.close(), member.close()]);
  }
});
