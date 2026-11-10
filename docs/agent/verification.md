# Verifica e review

- Dalla directory `frontend/`: `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` (browser offline). Dalla directory `backend/`: `npm run lint`, `npm test`, `npm run build`; `npm run test:integration` richiede sia `INTEGRATION_DATABASE_URL` sia `INTEGRATION_REDIS_URL` verso servizi disposable. Controllare prima i manifest se i comandi cambiano.
- La suite browser locale costruisce e serve gli asset: non sovrapporre build ed E2E nello stesso checkout. I test live/provider sono distinti da quelli offline e richiedono prerequisiti espliciti.
- Per un cambio di contratto condiviso compilare entrambi i package. I test backend non vengono typecheckati dalla build di produzione; controllare import ESM con suffisso `.js` e i test modificati.
- Per una review su worktree sporco, seguire [`references/worktree-audit.md`](references/worktree-audit.md) e registrare branch, HEAD, file modificati e non ignorati, escludendo i segreti. Non presentare un vecchio gate come verifica delle ultime modifiche; distinguere pass, fail e skip.
- `npm run verify` alla radice richiama PowerShell: in ambiente Linux senza il comando richiesto, usare separatamente i gate dei due package, senza dichiararli equivalenti a integration/E2E.

Questa è una mappa dei controlli, non un'affermazione che siano già stati eseguiti.
