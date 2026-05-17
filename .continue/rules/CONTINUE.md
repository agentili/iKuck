# iRicetto - Project Guide

## 1. Project Overview

**iRicetto** ("What's for dinner?") is a Progressive Web App (PWA) that helps users discover dinner/lunch recipes based on the ingredients they have in their pantry. The app uses a constraint-based algorithm to suggest 3 recipes: **2 with new ingredients + 1 with an ingredient the user has previously prepared**.

### Key Technologies
- **Frontend**: Vite + React 18 + TypeScript + TailwindCSS
- **State Management**: Zustand (local state) + TanStack Query (server state/cache)
- **Backend**: Supabase (PostgreSQL + Auth + Storage)
- **PWA**: `vite-plugin-pwa` + Workbox (offline-first, installable)
- **Routing**: React Router DOM v6
- **Icons**: Lucide React

### Architecture
The app follows a standard React component hierarchy with feature-based directory organization. Most directories are currently scaffolded but awaiting implementation. The PWA architecture uses a service worker for offline caching with Workbox strategies.

---

## 2. Getting Started

### Prerequisites
- **Node.js** ≥ 18.x
- **npm** (or yarn/pnpm)
- **Supabase account** (for backend)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd iRicetto

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

### Environment Setup
Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Running Tests
No test framework is currently configured. Consider adding Vitest or Jest for unit testing.

---

## 3. Project Structure

```
iRicetto/
├── public/
│   └── icons/              # PWA icons (192x192, 512x512)
├── src/
│   ├── api/                # Supabase API calls / queries
│   ├── components/
│   │   ├── common/         # Reusable UI components (buttons, inputs, etc.)
│   │   └── recipe/         # Recipe-specific components (cards, detail views)
│   ├── hooks/              # Custom React hooks
│   ├── layouts/            # Page layout wrappers
│   ├── lib/                # Utility functions, Supabase client, helpers
│   ├── pages/              # Route-level page components
│   ├── store/              # Zustand stores (pantry, auth, recipes)
│   ├── types/              # TypeScript type definitions
│   ├── sw.ts               # Service Worker (Workbox inject manifest)
│   ├── App.tsx             # Root app component with routing
│   ├── main.tsx            # Entry point (React DOM render)
│   └── index.css           # Global styles (Tailwind directives)
├── index.html              # HTML entry point
├── package.json            # Dependencies and scripts
├── plan.md                 # Detailed technical specification (Italian)
├── supabase_schema.sql     # Database schema with RLS policies
├── tailwind.config.js      # TailwindCSS configuration (primary color theme)
├── tsconfig.json           # TypeScript configuration (strict mode, path aliases)
├── tsconfig.node.json      # Node-side TypeScript config
├── vite.config.ts          # Vite config with React + PWA plugins
└── postcss.config.js       # PostCSS config (Tailwind + Autoprefixer)
```

### Key Configuration Files

| File | Purpose |
|------|---------|
| `vite.config.ts` | Vite build config with React plugin and PWA (inject manifest strategy) |
| `tailwind.config.js` | Tailwind theme with custom `primary` color palette (`#10b981`) |
| `tsconfig.json` | Strict TypeScript with `@/*` path alias pointing to `src/` |
| `plan.md` | Complete technical spec in Italian — **read this first** for business logic |
| `supabase_schema.sql` | Database schema with 5 tables + Row Level Security policies |

---

## 4. Development Workflow

### Coding Standards
- **TypeScript Strict Mode**: All files must pass `tsc` with zero errors
- **Path Aliases**: Use `@/` prefix for imports from `src/` (e.g., `@/components/common/Button`)
- **Component Style**: Functional components with TypeScript interfaces
- **Naming**: PascalCase for components, camelCase for functions/hooks, kebab-case for files

### State Management Strategy
- **Zustand**: For client-side state (pantry items, auth state, UI preferences)
- **TanStack Query**: For server-state synchronization with Supabase (recipes, history, pantry sync)
- **IndexedDB**: For offline caching of pantry and recipe data

### PWA Development Notes
- The service worker uses **inject manifest** strategy (`sw.ts`)
- Workbox handles precaching + runtime caching strategies:
  - `CacheFirst` for recipe images
  - `StaleWhileRevalidate` for Supabase API responses
- PWA manifest is configured in `vite.config.ts` (not a separate `manifest.json`)

### Database Schema
The schema includes 5 core tables with Row Level Security (RLS):

1. **profiles** — User accounts (extends Supabase auth)
2. **pantry_items** — User's ingredient inventory
3. **recipes** — Recipe catalog (difficulty ≤ 2, prep time ≤ 45 min)
4. **recipe_ingredients** — Many-to-many relationship between recipes and ingredients
5. **user_recipe_history** — Tracks which recipes a user has prepared (drives the algorithm)

### Contribution Guidelines
1. Read `plan.md` before implementing features — it contains the full specification
2. Follow the roadmap in `plan.md` (6-week development plan)
3. Ensure TypeScript strict mode passes (`npm run build` must succeed)
4. Mobile-first responsive design (TailwindCSS breakpoints)
5. Offline-first mindset — always consider the no-network scenario

---

## 5. Key Concepts

### The Suggestion Algorithm
The core feature is a constraint-based recipe suggestion algorithm (detailed in `plan.md` §4):

```
Input:  pantry items, recipe history, available recipes, meal type (lunch/dinner)
Output: 3 recipe suggestions

Rules:
- 2 recipes with NEW ingredients (not previously prepared by user)
- 1 recipe with an OLD ingredient (previously prepared by user)
- Fallback: if history is empty or constraints can't be met → 3 new recipes
- Minimum 3 matching ingredients from pantry
- Difficulty ≤ 2 (medium), prep time ≤ 45 minutes
```

### Ingredient Normalization
Ingredients are normalized to a canonical form for matching:
- `pomodori` → `pomodoro` (singularization)
- `carote` → `carota` (singularization)
- Case-insensitive comparison
- Fuzzy matching via Levenshtein distance for typos

### Offline-First Architecture
- **App shell** precached by service worker
- **Pantry data** synced to IndexedDB for offline access
- **Recipe cache** with stale-while-revalidate strategy
- **Background sync** for pantry updates when back online

### Meal Type Context
Recipes are suggested per meal type: `pranzo` (lunch) or `cena` (dinner). The UI includes a toggle for this.

---

## 6. Common Tasks

### Adding a New Page
1. Create a component in `src/pages/` (e.g., `src/pages/Dashboard.tsx`)
2. Add a route in `src/App.tsx`
3. Add navigation links in the appropriate layout

### Adding a Zustand Store
1. Create `src/store/<name>.ts`
2. Define state interface and store with `create()` from Zustand
3. Use `useStore()` hook in components

### Adding a Supabase Query
1. Create a function in `src/lib/supabase.ts` or `src/api/`
2. Use TanStack Query's `useQuery` / `useMutation` in components
3. Handle loading, error, and empty states

### Updating the Database Schema
1. Modify `supabase_schema.sql`
2. Apply changes to your Supabase project
3. Update TypeScript types in `src/types/` to match

### Testing PWA Features
```bash
# Build and preview locally
npm run build
npm run preview

# Or use dev mode with PWA enabled
npm run dev
# Open DevTools → Application → Service Workers
```

---

## 7. Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| TypeScript path alias `@/` not resolving | Ensure `tsconfig.json` has `"paths": {"@/*": ["src/*"]}` and your IDE has TypeScript configured |
| Service worker not updating | Clear browser cache, or use Incognito mode. PWA cache can persist across refreshes |
| Supabase RLS blocking queries | Verify user is authenticated (`auth.uid()`) and check policy definitions in `supabase_schema.sql` |
| PWA icons not appearing | Ensure icons exist in `public/icons/` with correct filenames and sizes (192x192, 512x512) |
| Ingredient matching failing | Check normalization logic — ensure both pantry and recipe ingredients use the same `normalized_name` |
| Build fails with TypeScript errors | Run `npm run lint` first to catch issues. Strict mode is enforced |

### Debugging Tips
- Use React DevTools for component tree and Zustand state inspection
- Use TanStack Query DevTools for cache/query debugging
- Check Service Worker registration in Chrome DevTools → Application → Service Workers
- Use `console.log` with TypeScript types for type-safe debugging
- The `plan.md` file contains detailed algorithm logic — reference it when debugging suggestion results

---

## 8. References

### Internal Documentation
- **`plan.md`** — Complete technical specification (Italian) with algorithm, schema, roadmap, and LLM prompts
- **`supabase_schema.sql`** — Database schema with RLS policies

### External Resources
- [Vite Documentation](https://vitejs.dev/)
- [React 18 Documentation](https://react.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [TailwindCSS Documentation](https://tailwindcss.com/)
- [Supabase Documentation](https://supabase.com/docs)
- [Zustand Documentation](https://zustand.docs.pmnd.rs/)
- [TanStack Query Documentation](https://tanstack.com/query/latest)
- [vite-plugin-pwa Documentation](https://github.com/vite-pwa/vite-plugin-pwa)
- [Workbox Documentation](https://developer.chrome.com/docs/workbox/)
- [React Router Documentation](https://reactrouter.com/)

### Project-Specific Notes
- Primary color: `#10b981` (emerald-500) — defined in `tailwind.config.js` as `primary`
- The app is mobile-first and portrait-oriented
- All recipe constraints: difficulty ≤ 2, prep time ≤ 45 minutes
- Algorithm logic is fully documented in `plan.md` section 4 — **always reference this before modifying suggestion logic**
