# iRicetto - Project Guide

## 1. Project Overview

**iRicetto** ("What's for dinner?") is a Progressive Web App (PWA) designed to help users discover dinner or lunch recipes based on the ingredients they currently have in their pantry. It focuses on a mobile-first, offline-ready experience to be used directly in the kitchen.

### Core Value Proposition
- **Smart Suggestions**: A constraint-based algorithm suggests 3 recipes: 2 with new ingredients and 1 with an ingredient previously used.
- **Efficiency**: Recipes are limited to a preparation time of ≤ 45 minutes and a difficulty level of ≤ 2.
- **Offline-First**: Accessible even without an internet connection using Service Workers and IndexedDB.

### Tech Stack
- **Frontend**: [React 18](https://react.dev/) + [Vite 5](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **Backend-as-a-Service**: [Supabase](https://supabase.com/) (Auth, PostgreSQL, RLS)
- **State Management**: [Zustand](https://zustand.docs.pmnd.rs/) (Local) + [TanStack Query](https://tanstack.com/query/latest) (Server)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) (Emerald/Green theme)
- **PWA**: `vite-plugin-pwa` + [Workbox](https://developer.chrome.com/docs/workbox/)
- **Icons**: [Lucide React](https://lucide.dev/)

---

## 2. Building and Running

### Prerequisites
- Node.js ≥ 18.x
- npm (or your preferred package manager)
- A Supabase project

### Setup
1.  **Clone and Install**:
    ```bash
    npm install
    ```
2.  **Environment Variables**:
    Create a `.env` file in the root directory:
    ```env
    VITE_SUPABASE_URL=your_supabase_url
    VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
    ```
3.  **Database**:
    Apply the schema in `supabase_schema.sql` to your Supabase SQL Editor.

### Development Commands
- `npm run dev`: Starts the Vite development server.
- `npm run build`: Compiles the project using TypeScript (`tsc`) and Vite.
- `npm run preview`: Previews the local production build.
- `npm run lint`: Runs ESLint with strict rules.

---

## 3. Architecture & Structure

The project uses a feature-based directory organization within `src/`:

```
iRicetto/
├── public/             # Static assets, PWA icons
├── src/
│   ├── api/            # Data fetching logic (Supabase queries)
│   ├── components/     # UI Components
│   │   ├── common/     # Reusable atoms (Buttons, Inputs)
│   │   └── recipe/     # Recipe-specific features
│   ├── hooks/          # Custom React hooks
│   ├── layouts/        # Shared page layouts
│   ├── lib/            # External library init (Supabase client)
│   ├── pages/          # Route-level components
│   ├── store/          # Zustand stores
│   ├── types/          # TypeScript definitions
│   ├── sw.ts           # Custom Service Worker logic
│   ├── App.tsx         # Routing and Providers
│   └── main.tsx        # Entry point
├── iRicetto_plan.md    # Full technical specification (Italian)
├── supabase_schema.sql # Database schema & RLS policies
└── vite.config.ts      # Vite & PWA configuration
```

---

## 4. Development Conventions

- **Strict TypeScript**: `strict: true` is enabled. Avoid `any` and ensure all components have proper prop types/interfaces.
- **Path Aliases**: Use `@/` to reference the `src` directory (e.g., `import { Button } from '@/components/common/Button'`).
- **Component Style**: Use Functional Components with the `tsx` extension.
- **Naming Conventions**:
    - **Components**: PascalCase (e.g., `RecipeCard.tsx`)
    - **Hooks/Functions**: camelCase (e.g., `usePantry.ts`)
    - **Files**: kebab-case is preferred for non-component files, PascalCase for components.
- **State Strategy**:
    - Use **TanStack Query** for all data-fetching and server-state sync.
    - Use **Zustand** for transient UI state and pantry interactions.
- **Styling**: Use utility-first Tailwind classes. Follow the mobile-first approach.
- **PWA**: Development should always consider offline scenarios. Ensure the manifest and service worker are kept up to date.

---

## 5. Key Business Logic

### Suggestion Algorithm
The core algorithm (documented in `iRicetto_plan.md`) selects 3 recipes based on:
1.  **Pantry Match**: At least 3 ingredients must match.
2.  **History**: 2 "New" recipes + 1 "Old" (previously cooked).
3.  **Constraints**: Difficulty ≤ 2, Prep Time ≤ 45m.
4.  **Meal Type**: Filtered by lunch (`pranzo`) or dinner (`cena`).

### Ingredient Normalization
Ingredients are stored and compared using a `normalized_name` (e.g., singular form, lowercase) to ensure consistent matching between the pantry and recipe requirements.
