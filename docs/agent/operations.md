# Operazioni e rilascio

- Per il rilascio consultare `docs/git-release-policy.md`, `docs/production-readiness.md`, gli script in `deploy/` e la versione distribuita tramite `/version.json`. In caso di divergenza tra documenti e pratica corrente, **fermarsi e riconciliare** prima di tag, merge o deploy.
- Prima di agire su staging o produzione, identificare il progetto Compose/Podman effettivo, file env, servizi, mount e volumi. Non presumere che un vecchio hostname, IP, porto, branch o build ID della skill storica descriva lo stato odierno.
- Preservare i volumi persistenti; non eseguire `down --volumes` sul progetto canonico o di produzione. Per test d'integrazione usare risorse disposable con nome univoco e verificare lo scope prima di qualsiasi cleanup.
- Verificare readiness, build ID in `/version.json`, route interessata e confini di sicurezza dell'origine HTTPS. Una preview locale non equivale a un deploy. Non pubblicare, riavviare servizi o modificare segreti senza autorizzazione esplicita.
- La skill storica conteneva una procedura di release che crea il tag **dopo** il merge, mentre `docs/git-release-policy.md` descrive il tag **prima** del merge. Questa divergenza non è stata risolta dalla migrazione: richiede una decisione aggiornata prima di un rilascio.
