import { create } from 'zustand';
import type { ChatMessage, QuickReply, DayData, RecipeMessage, DraftMessage, TextMessage } from './types';

export interface RecipeData {
  id: string;
  title: string;
  emoji: string;
  time: string;
  servings: number;
  tags: string[];
  image: string;
  description: string;
  ingredients: Array<{ name: string; amount: string }>;
  steps: string[];
  diets: string[];
  allergens: string[];
}

const createFullRecipe = (partial: Partial<RecipeData> & { id: string; title: string; emoji: string; time: string; servings: number; tags: string[]; image: string; description: string }): RecipeData => ({
  id: partial.id,
  title: partial.title,
  emoji: partial.emoji,
  time: partial.time,
  servings: partial.servings,
  tags: partial.tags,
  image: partial.image,
  description: partial.description,
  ingredients: partial.ingredients ?? [],
  steps: partial.steps ?? [],
  diets: partial.diets ?? [],
  allergens: partial.allergens ?? [],
});

const initialDayData: Record<'today' | 'yesterday' | 'dayBefore', DayData> = {
  today: {
    key: 'today',
    label: 'Oggi',
    shortLabel: 'OGG',
    recipe: createFullRecipe({
      id: '1',
      title: 'Spaghetti al pomodoro',
      emoji: '🍝',
      time: '20 min',
      servings: 2,
      tags: ['Vegetariano', 'Veloce', 'Classico'],
      image: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800&q=80',
      description: 'Pochi ingredienti, tecnica giusta: pomodori San Marzano, aglio intero dorato nell\'olio extravergine, basilico fresco alla fine. Il segreto? La mantecatura con acqua di cottura.',
      ingredients: [
        { name: 'Spaghetti', amount: '320g' },
        { name: 'Pomodori San Marzano', amount: '600g' },
        { name: 'Aglio', amount: '2 spicchi' },
        { name: 'Olio EVO', amount: 'qb' },
        { name: 'Basilico fresco', amount: 'qualche foglia' },
        { name: 'Sale grosso', amount: 'qb' },
      ],
      steps: [
        'Metti l\'acqua a bollire con sale grosso.',
        'In padella larga, scalda olio con aglio intero.',
        'Aggiungi pomodori spezzettati, cuoci 15 min schiacciando.',
        'Butta la pasta, scolala 2 min prima.',
        'Manteca in padella con acqua di cottura e basilico.',
      ],
      diets: ['vegetarian'],
      allergens: [],
    }),
    alternatives: [
      { id: '4', title: 'Pasta aglio olio peperoncino', emoji: '🍝', time: '15 min', servings: 2, tags: ['Veloce', 'Vegetariano'], image: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=400&q=80' },
      { id: '5', title: 'Frittata di verdure miste', emoji: '🍳', time: '20 min', servings: 3, tags: ['Vegetariano', 'Svuotafrigo'], image: 'https://images.unsplash.com/photo-1581819667455-2d2a8e8c3b56?w=400&q=80' },
    ],
  },
  yesterday: {
    key: 'yesterday',
    label: 'Ieri',
    shortLabel: 'IER',
    recipe: createFullRecipe({
      id: '2',
      title: 'Pollo al limone e rosmarino',
      emoji: '🍗',
      time: '45 min',
      servings: 4,
      tags: ['Forno', 'Cena', 'Proteico'],
      image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=800&q=80',
      description: 'Pelle croccante, carne succosa. Marinatura veloce con limone, aglio, rosmarino e olio.',
      ingredients: [
        { name: 'Pollo intero', amount: '1 kg' },
        { name: 'Limoni', amount: '2' },
        { name: 'Rosmarino fresco', amount: 'qb' },
        { name: 'Aglio', amount: '4 spicchi' },
        { name: 'Olio EVO', amount: 'qb' },
        { name: 'Sale, pepe', amount: 'qb' },
      ],
      steps: [
        'Marina il pollo 30 min con limone, aglio, rosmarino, olio.',
        'Scalda forno a 200°C.',
        'Inforna 45 min bagnando col sugo.',
        'Riposa 10 min prima di servire.',
      ],
      diets: [],
      allergens: [],
    }),
    alternatives: [
      { id: '6', title: 'Salmone al forno con patate', emoji: '🐟', time: '30 min', servings: 2, tags: ['Forno', 'Sano'], image: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400&q=80' },
      { id: '7', title: 'Hamburger fatti in casa', emoji: '🍔', time: '30 min', servings: 4, tags: ['Carne', 'Comfort'], image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80' },
    ],
  },
  dayBefore: {
    key: 'dayBefore',
    label: "L'altro ieri",
    shortLabel: 'ALT',
    recipe: createFullRecipe({
      id: '3',
      title: 'Risotto ai funghi porcini',
      emoji: '🍚',
      time: '35 min',
      servings: 2,
      tags: ['Vegetariano', 'Elegante', 'Cremoso'],
      image: 'https://images.unsplash.com/photo-1476124369491-e7addf5db371?w=800&q=80',
      description: 'Cremoso al punto giusto. Funghi saltati a parte, uniti a fine cottura con parmigiano 36 mesi.',
      ingredients: [
        { name: 'Riso Carnaroli', amount: '200g' },
        { name: 'Funghi porcini', amount: '300g' },
        { name: 'Brodo vegetale', amount: '1 litro' },
        { name: 'Cipolla', amount: '1' },
        { name: 'Vino bianco', amount: '1 bicchiere' },
        { name: 'Parmigiano 36m', amount: '80g' },
        { name: 'Burro', amount: '50g' },
      ],
      steps: [
        'Tosta il riso in burro e cipolla.',
        'Sfuma col vino.',
        'Aggiungi brodo un mestolo alla volta.',
        'Saltare funghi a parte.',
        'Unisci funghi e manteca col parmigiano.',
      ],
      diets: ['vegetarian'],
      allergens: [],
    }),
    alternatives: [
      { id: '8', title: 'Pasta alla carbonara', emoji: '🍝', time: '20 min', servings: 2, tags: ['Classico', 'Veloce'], image: 'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=400&q=80' },
      { id: '9', title: 'Parmigiana di melanzane', emoji: '🍆', time: '60 min', servings: 4, tags: ['Vegetariano', 'Forno', 'Classico'], image: 'https://images.unsplash.com/photo-1574894709920-11b28e7723e3?w=400&q=80' },
    ],
  },
};

const initialQuickReplies: QuickReply[] = [
  { id: 'more', label: 'Altre idee', action: 'more' },
  { id: 'pantry', label: 'Cosa ho in dispensa?', action: 'pantry' },
  { id: 'veg', label: 'Solo vegetariano', action: 'veg' },
  { id: 'fast', label: 'Meno di 20 min', action: 'fast' },
  { id: 'shopping', label: 'Lista spesa', action: 'shopping' },
  { id: 'house', label: 'Casa', action: 'house' },
];

// Define the full store type with all actions
interface ChatStoreState {
  // State
  messages: ChatMessage[];
  selectedDay: 'today' | 'yesterday' | 'dayBefore';
  dayData: Record<'today' | 'yesterday' | 'dayBefore', DayData>;
  quickReplies: QuickReply[];
  isGenerating: boolean;
  isSaving: boolean;
  error: string | null;
  drafts: DraftMessage['recipe'][];
  savedRecipes: RecipeMessage['recipe'][];
  consentStatus: 'unknown' | 'required' | 'granted' | 'revoked';
  selectedProvider: 'openai' | 'gemini' | null;

  // Actions
  addMessage: (message: ChatMessage) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  selectDay: (day: 'today' | 'yesterday' | 'dayBefore') => void;
  setQuickReplies: (replies: QuickReply[]) => void;
  setGenerating: (isGenerating: boolean) => void;
  setSaving: (isSaving: boolean) => void;
  setError: (error: string | null) => void;
  addDraft: (draft: DraftMessage['recipe']) => void;
  removeDraft: (id: string) => void;
  saveDraft: (draft: DraftMessage['recipe']) => void;
  addSavedRecipe: (recipe: RecipeMessage['recipe']) => void;
  setConsentStatus: (status: 'unknown' | 'required' | 'granted' | 'revoked') => void;
  setSelectedProvider: (provider: 'openai' | 'gemini' | null) => void;
  handleQuickReply: (action: QuickReply['action'], payload?: string) => void;
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  messages: [
    {
      id: 'welcome-1',
      role: 'assistant',
      type: 'text',
      timestamp: new Date(),
      content: "Ciao! 👋 Oggi ti propongo **🍝 Spaghetti al pomodoro** — 20 min per 2 persone. Ti va?",
    },
    {
      id: 'welcome-2',
      role: 'assistant',
      type: 'recipe',
      timestamp: new Date(),
      recipe: initialDayData.today.recipe,
    },
  ],
  selectedDay: 'today',
  dayData: initialDayData,
  quickReplies: initialQuickReplies,
  isGenerating: false,
  isSaving: false,
  error: null,
  drafts: [],
  savedRecipes: [],
  consentStatus: 'unknown',
  selectedProvider: null,

  // Actions
  addMessage: (message: ChatMessage) => set((state) => ({
    messages: [...state.messages, message],
  })),

  setMessages: (messages: ChatMessage[]) => set({ messages }),

  clearMessages: () => set({ messages: [] }),

  selectDay: (day: 'today' | 'yesterday' | 'dayBefore') => {
    const dayData = get().dayData[day];
    set({ selectedDay: day });
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `day-${day}-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: `Ecco la ricetta di **${dayData.label}**: **${dayData.recipe.emoji} ${dayData.recipe.title}** — ${dayData.recipe.time} per ${dayData.recipe.servings} persone.`,
        } as TextMessage,
        {
          id: `day-${day}-recipe-${Date.now()}`,
          role: 'assistant',
          type: 'recipe',
          timestamp: new Date(),
          recipe: dayData.recipe,
        } as RecipeMessage,
      ],
    }));
  },

  setQuickReplies: (replies: QuickReply[]) => set({ quickReplies: replies }),

  setGenerating: (isGenerating: boolean) => set({ isGenerating }),

  setSaving: (isSaving: boolean) => set({ isSaving }),

  setError: (error: string | null) => set({ error }),

  addDraft: (draft: DraftMessage['recipe']) => set((state) => ({
    drafts: [draft, ...state.drafts],
  })),

  removeDraft: (id: string) => set((state) => ({
    drafts: state.drafts.filter((d) => d.id !== id),
  })),

  saveDraft: (draft: DraftMessage['recipe']) => set((state) => ({
    drafts: state.drafts.filter((d) => d.id !== draft.id),
    savedRecipes: [draft, ...state.savedRecipes],
  })),

  addSavedRecipe: (recipe: RecipeMessage['recipe']) => set((state) => ({
    savedRecipes: [recipe, ...state.savedRecipes],
  })),

  setConsentStatus: (status: 'unknown' | 'required' | 'granted' | 'revoked') => set({ consentStatus: status }),

  setSelectedProvider: (provider: 'openai' | 'gemini' | null) => set({ selectedProvider: provider }),

  // Quick reply handlers
  handleQuickReply: (action: QuickReply['action'], payload?: string) => {
    const { selectedDay, dayData } = get();
    const todayData = dayData[selectedDay];

    switch (action) {
      case 'more': {
        const altRecipes = todayData.alternatives.map((alt) => ({
          id: `alt-${alt.id}-${Date.now()}`,
          role: 'assistant' as const,
          type: 'recipe' as const,
          timestamp: new Date(),
          recipe: createFullRecipe({
            id: alt.id,
            title: alt.title,
            emoji: alt.emoji,
            time: alt.time,
            servings: alt.servings,
            tags: alt.tags,
            image: alt.image,
            description: '',
            ingredients: [],
            steps: [],
            diets: [],
            allergens: [],
          }),
        }));
        set((state) => ({
          messages: [...state.messages, ...altRecipes],
        }));
        break;
      }
      case 'pantry': {
        const msg: TextMessage = {
          id: `pantry-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'Non ho accesso diretto alla dispensa in questa demo 😊\n\nMa se mi dici cosa hai (es. "pasta, uova, pomodori"), ti dico cosa cucinare!',
        };
        set((state) => ({ messages: [...state.messages, msg] }));
        break;
      }
      case 'veg': {
        const vegRecipes = todayData.alternatives
          .filter((a) => a.tags.includes('Vegetariano'))
          .map((alt) => ({
            id: `veg-${alt.id}-${Date.now()}`,
            role: 'assistant' as const,
            type: 'recipe' as const,
            timestamp: new Date(),
            recipe: createFullRecipe({
              id: alt.id,
              title: alt.title,
              emoji: alt.emoji,
              time: alt.time,
              servings: alt.servings,
              tags: alt.tags,
              image: alt.image,
              description: '',
              ingredients: [],
              steps: [],
              diets: [],
              allergens: [],
            }),
          }));
        const msg: TextMessage = {
          id: `veg-intro-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'Ecco le vegetariane per oggi:',
        };
        set((state) => ({ messages: [...state.messages, msg, ...vegRecipes] }));
        break;
      }
      case 'fast': {
        const fastRecipes = todayData.alternatives
          .filter((a) => parseInt(a.time) < 20)
          .map((alt) => ({
            id: `fast-${alt.id}-${Date.now()}`,
            role: 'assistant' as const,
            type: 'recipe' as const,
            timestamp: new Date(),
            recipe: createFullRecipe({
              id: alt.id,
              title: alt.title,
              emoji: alt.emoji,
              time: alt.time,
              servings: alt.servings,
              tags: alt.tags,
              image: alt.image,
              description: '',
              ingredients: [],
              steps: [],
              diets: [],
              allergens: [],
            }),
          }));
        const msg: TextMessage = {
          id: `fast-intro-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'Flash! ⚡ Ecco le più veloci:',
        };
        set((state) => ({ messages: [...state.messages, msg, ...fastRecipes] }));
        break;
      }
      case 'diary': {
        const msg: TextMessage = {
          id: `diary-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'Il tuo diario cotture è disponibile alla pagina "Salvate" → sezione Diario. Vuoi che ti ci porti?',
        };
        set((state) => ({ messages: [...state.messages, msg] }));
        break;
      }
      case 'shopping': {
        const msg: TextMessage = {
          id: `shopping-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'La lista spesa ti aspetta nella pagina dedicata. Tocca "Lista spesa" in basso per vederla!',
        };
        set((state) => ({ messages: [...state.messages, msg] }));
        break;
      }
      case 'house': {
        const msg: TextMessage = {
          id: `house-${Date.now()}`,
          role: 'assistant',
          type: 'text',
          timestamp: new Date(),
          content: 'La gestione della casa (condivisione dispense, membri) si trova nella pagina "Casa".',
        };
        set((state) => ({ messages: [...state.messages, msg] }));
        break;
      }
      case 'custom': {
        if (payload) {
          const userMsg: TextMessage = {
            id: `custom-${Date.now()}`,
            role: 'user',
            type: 'text',
            timestamp: new Date(),
            content: payload,
          };
          set((state) => ({ messages: [...state.messages, userMsg] }));
          setTimeout(() => {
            const response: TextMessage = {
              id: `ai-response-${Date.now()}`,
              role: 'assistant',
              type: 'text',
              timestamp: new Date(),
              content: `Ho capito: "${payload}". Cerco qualcosa di adatto... 🤔\n\nProva a dirmi: "veloce", "vegetariano", "pollo", "pesce", "forno" o "svuotafrigo".`,
            };
            set((state) => ({ messages: [...state.messages, response] }));
          }, 800);
        }
        break;
      }
    }
  },
}));