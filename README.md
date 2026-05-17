# Meal Planner PWA

Suggerimenti intelligenti per la tua cena in base alla dispensa.

## Tecnologie
- **Frontend**: React, Vite, TypeScript, TailwindCSS
- **Backend**: Node.js, Express, PostgreSQL, Redis
- **Infrastruttura**: Docker, Docker Compose

## Setup Sviluppo
1. `cp .env.example .env` e configura le variabili.
2. `docker compose up -d postgres redis`
3. Backend: `cd backend && npm install && npm run dev`
4. Frontend: `cd frontend && npm install && npm run dev`

## Deploy
Esegui lo script di deploy:
```bash
./scripts/deploy.sh
```

Assicurati di avere Docker e Docker Compose installati sulla VPS.
