# Git & Release Policy — iKuck

## Regola base

- Le release esistono esclusivamente come **tag git** (es. `v1.14.0`).
- Esiste un **singolo branch permanente `main`**.
- Branch temporanei sono ammessi solo per **feature in sviluppo** e vanno chiusi dopo il merge in `main`.

## Workflow di rilascio

1. Lavoro su un branch dedicato (es. `release/vX.Y.Z` o `feat/...`).
2. Bump della versione in `frontend/package.json` **prima** del tag.
3. Commit delle modifiche sul branch di lavoro.
4. Push del branch e creazione del tag `vX.Y.Z`.
5. Merge del branch in `main`.
6. Push di `main`.
7. Deploy in produzione seguendo `docs/production-readiness.md` (backup PostgreSQL, build, health check).
8. Il branch di release può essere rimosso dopo il merge: il release rimane riferito dal tag.

## Convenzioni

- Nessun push o deploy automatico: commit e tag solo quando esplicitamente richiesto.
- I tag non vengono mai spostati dopo il push su remoto, salvo correzione immediata pre-produzione.
- Versioning PWA: `frontend/package.json` espone `/version.json`; `VITE_BUILD_ID` deve passare negli arg di build di Caddy (standalone e produzione).
- Prima di ogni modifica in produzione: backup del database PostgreSQL (non rimuovere mai i volumi come passo di debug).
- Commit e tag solo quando il piano di rilascio lo richiede; non unire o spingere automaticamente.
