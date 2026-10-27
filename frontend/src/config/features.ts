// Feature flags per SOUS-CHEF UI rollout
// Controllato via VITE_SOUS_CHEF env variable (true/false)

export const FEATURES = {
  /** Abilita la nuova UI SOUS-CHEF (chat-first) */
  SOUS_CHEF_UI: import.meta.env.VITE_SOUS_CHEF === 'true',

  /** Landing page chat invece di HomePage classica */
  CHAT_LANDING: import.meta.env.VITE_SOUS_CHEF === 'true',

  /** Bottom navigation fissa (Chef, Cerca, Piano, Salvate) */
  BOTTOM_NAV: import.meta.env.VITE_SOUS_CHEF === 'true',

  /** Header semplificato (solo logo + profilo + theme) */
  SIMPLIFIED_HEADER: import.meta.env.VITE_SOUS_CHEF === 'true',

  /** RecipeDetailModal al posto di RecipeDetailPage */
  RECIPE_MODAL: import.meta.env.VITE_SOUS_CHEF === 'true',

  /** DiscoverPage e SavedPage come tab dedicate */
  DISCOVER_SAVED_TABS: import.meta.env.VITE_SOUS_CHEF === 'true',
} as const;

// Helper per feature flag in componenti
export const isSousChef = () => FEATURES.SOUS_CHEF_UI;
export const isChatLanding = () => FEATURES.CHAT_LANDING;
export const isBottomNav = () => FEATURES.BOTTOM_NAV;
export const isSimplifiedHeader = () => FEATURES.SIMPLIFIED_HEADER;
export const isRecipeModal = () => FEATURES.RECIPE_MODAL;
export const isDiscoverSavedTabs = () => FEATURES.DISCOVER_SAVED_TABS;