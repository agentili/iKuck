# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend/e2e/recipe-library.spec.ts >> offline: catalogo consultabile, gruppo salvate in errore non bloccante
- Location: frontend/e2e/recipe-library.spec.ts:217:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/recipes", waiting until "load"

```

# Test source

```ts
  134 |     .filter({ has: page.getByRole('heading', { name: 'Orata al forno' }) });
  135 |   await expect(orataCard).toBeVisible();
  136 |   await expect(orataCard.getByRole('button', { name: 'Mostra dettagli' })).toBeVisible();
  137 |   await orataCard.getByRole('button', { name: 'Mostra dettagli' }).click();
  138 |   await expect(orataCard.getByRole('button', { name: 'Nascondi dettagli' })).toBeVisible();
  139 |   await expect(orataCard.getByText('orata', { exact: true })).toBeVisible();
  140 |   await expect(
  141 |     orataCard.getByText('Cuoci in forno statico a 200 °C per 25 minuti.'),
  142 |   ).toBeVisible();
  143 | });
  144 | 
  145 | test('gruppo suggerite: la card apre /recipes/:recipeId', async ({ page }) => {
  146 |   await installVerifiedBackend(page);
  147 |   await page.goto('/recipes');
  148 |   await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  149 |   await expect(page).toHaveURL('/recipes/pasta-tonno-pomodoro');
  150 |   await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  151 | });
  152 | 
  153 | test('ospite: catalogo visibile, gruppo salvate con CTA accesso', async ({ page }) => {
  154 |   // Nessuna sessione verificata: il backend offline di base risponde authenticated: false
  155 |   // e la pagina non chiama fetchAiRecipes.
  156 |   await page.goto('/recipes');
  157 |   await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  158 |   await expect(page.getByRole('heading', { name: 'Ricette suggerite' })).toBeVisible();
  159 |   await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  160 |   await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
  161 |   await expect(page.getByRole('heading', { name: 'Ricette AI riservate agli account verificati' })).toBeVisible();
  162 |   const accessLink = page.getByRole('link', { name: 'Accedi al tuo account' });
  163 |   await expect(accessLink).toBeVisible();
  164 |   await expect(accessLink).toHaveAttribute('href', '/profile');
  165 |   await expect(page.getByRole('button', { name: /Mostra dettagli/ })).toHaveCount(0);
  166 | });
  167 | 
  168 | for (const theme of ['light', 'dark'] as const) {
  169 |   test(`axe: zero violazioni su /recipes in modalità ${theme}`, async ({ page }) => {
  170 |     await page.emulateMedia({ colorScheme: 'light' });
  171 |     await page.addInitScript(
  172 |       ({ key, preference }: { key: string; preference: 'light' | 'dark' }) => {
  173 |         localStorage.setItem(key, preference);
  174 |       },
  175 |       { key: themePreferenceKey, preference: theme },
  176 |     );
  177 |     await installVerifiedBackend(page);
  178 |     await page.goto('/recipes');
  179 |     await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  180 |     await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  181 | 
  182 |     const results = await new AxeBuilder({ page }).analyze();
  183 |     expect(results.violations, `${theme} axe violations on /recipes`).toEqual([]);
  184 |   });
  185 | }
  186 | 
  187 | test('nav: «Ricette» raggiungibile, nome accessibile completo, nessun overflow a 320px', async ({
  188 |   page,
  189 | }) => {
  190 |   await page.setViewportSize({ width: 320, height: 700 });
  191 |   await page.evaluate(() => {
  192 |     document.documentElement.style.fontSize = '200%';
  193 |   });
  194 |   await page.route('**/v1/house', (route) => route.fulfill({ status: 200, json: { house: null } }));
  195 |   await page.goto('/');
  196 | 
  197 |   const ricette = page.getByRole('link', { name: 'Ricette' });
  198 |   await expect(ricette).toBeVisible();
  199 | 
  200 |   const geometry = await page.evaluate(() => ({
  201 |     viewport: document.documentElement.clientWidth,
  202 |     content: document.documentElement.scrollWidth,
  203 |     nav: document
  204 |       .querySelector('nav[aria-label="Navigazione principale"]')
  205 |       ?.getBoundingClientRect()
  206 |       .toJSON() ?? null,
  207 |     main: document.querySelector('main#main-content')?.getBoundingClientRect()?.toJSON() ?? null,
  208 |   }));
  209 |   expect(
  210 |     geometry.content,
  211 |     `overflow orizzontale a 320px: ${JSON.stringify(geometry)}`,
  212 |   ).toBeLessThanOrEqual(geometry.viewport);
  213 |   expect(geometry.nav).not.toBeNull();
  214 |   expect(geometry.main).not.toBeNull();
  215 | });
  216 | 
  217 | test('offline: catalogo consultabile, gruppo salvate in errore non bloccante', async ({
  218 |   page,
  219 |   context,
  220 | }) => {
  221 |   // Tutto il bootstrap è mockato tranne GET /v1/ai-recipes: deve fallire offline.
  222 |   await installOfflineBackend(page, {
  223 |     responses: {
  224 |       'GET /v1/auth/session': { status: 200, json: verifiedSession },
  225 |       'GET /v1/house': { status: 200, json: { house: null } },
  226 |       'GET /v1/sync': { status: 200, json: { changes: [], nextCursor: 0 } },
  227 |       'POST /v1/sync': {
  228 |         status: 200,
  229 |         json: { uploaded: 0, downloaded: 0, pending: 0, complete: true },
  230 |       },
  231 |     },
  232 |   });
  233 |   await page.route('**/v1/ai-recipes', (route) => route.abort());
> 234 |   await page.goto('/recipes');
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  235 |   await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  236 | 
  237 |   // Il catalogo statico resta consultabile offline.
  238 |   await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  239 |   await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
  240 | 
  241 |   // Il gruppo salvate è in stato d'errore ma non blocca la pagina.
  242 |   await expect(page.getByRole('alert')).toBeVisible();
  243 |   await expect(
  244 |     page.getByText(
  245 |       'Servizio non raggiungibile: le ricette AI restano disponibili solo online.',
  246 |     ),
  247 |   ).toBeVisible();
  248 |   await expect(page.getByRole('heading', { name: 'Orata al forno' })).toHaveCount(0);
  249 | 
  250 |   await context.setOffline(true);
  251 |   await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  252 | });
  253 | 
```