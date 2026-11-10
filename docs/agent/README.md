# Contesto iKuck per agenti

Parti da [`../../AGENTS.md`](../../AGENTS.md). Questo indice è una mappa: **apri solo il documento pertinente al task**. I contratti e il codice prevalgono sulle descrizioni; per i requisiti di prodotto verifica la decisione approvata più recente.

| Task | Leggi |
| --- | --- |
| Prodotto, navigazione e UX | [`product.md`](product.md), [`../../DESIGN.md`](../../DESIGN.md), route in `../../frontend/src/App.tsx` |
| Sync, casa, migrazioni e dati guest | [`../../shared/src/contracts.ts`](../../shared/src/contracts.ts), [`../shared-households.md`](../shared-households.md), [`data.md`](data.md) |
| Ricette AI, consenso, provider | [`ai.md`](ai.md), route e adapter correnti in `../../backend/src/` |
| Test e review | [`verification.md`](verification.md), script e package manifest correnti |
| Release e deployment | [`operations.md`](operations.md), [`../git-release-policy.md`](../git-release-policy.md), [`../production-readiness.md`](../production-readiness.md) |

Le guide specialistiche per [UX](references/frontend-ux.md) e [audit di worktree](references/worktree-audit.md) si aprono solo quando servono, verificandole rispetto al checkout corrente. La vecchia skill monolitica e la sua copia d'archivio sono state rimosse; le contraddizioni rilevate sono elencate in [`migration-audit.md`](migration-audit.md).
