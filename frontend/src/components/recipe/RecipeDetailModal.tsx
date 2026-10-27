import { memo, useEffect, useRef, useState } from 'react';
import { X, ChefHat, Clock, Users, Save, Trash2, Share2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useShoppingListStore } from '../../store/shoppingListStore';
import { useAuthStore } from '../../auth/authStore';
import { deleteAiRecipe, saveAiRecipe } from '../../ai/aiRecipeApi';
import { ApiClientError } from '../../api/apiClient';
import { usePantryStore } from '../../store/localPantryStore';

interface RecipeDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipe: {
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
    source?: 'catalog' | 'ai' | 'diary';
  } | null;
  onStartCooking?: (recipe: any) => void;
}

const Tag = ({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'ready' | 'missing' }) => (
  <span
    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      variant === 'ready'
        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
        : variant === 'missing'
        ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
        : 'bg-[var(--sc-peach-soft)] text-[var(--sc-terracotta)] dark:bg-[var(--sc-peach-soft)] dark:text-[var(--sc-terracotta)]'
    }`}
  >
    {children}
  </span>
);

const DIET_LABELS: Record<string, string> = {
  vegetarian: 'Vegetariano',
  vegan: 'Vegano',
  gluten_free: 'Senza glutine',
  dairy_free: 'Senza latticini',
  keto: 'Keto',
  paleo: 'Paleo',
  low_carb: 'Low carb',
  high_protein: 'High protein',
};

const ALLERGEN_LABELS: Record<string, string> = {
  gluten: 'Glutine',
  crustaceans: 'Crostacei',
  eggs: 'Uova',
  fish: 'Pesce',
  peanuts: 'Arachidi',
  soy: 'Soia',
  milk: 'Latte',
  nuts: 'Frutta a guscio',
  celery: 'Sedano',
  mustard: 'Senape',
  sesame: 'Sesamo',
  sulphites: 'Solfiti',
  lupin: 'Lupino',
  molluscs: 'Molluschi',
};

export const RecipeDetailModal = memo(({ 
  isOpen, 
  onClose, 
  recipe, 
  onStartCooking 
}: RecipeDetailModalProps) => {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const pantryLabels = usePantryStore((state) => state.getAvailableIngredientIds());
  
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;
    previousActiveElement.current = document.activeElement as HTMLElement;
    const focusableElements = modalRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusableElements?.length) return;
    
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
    
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };
    
    document.addEventListener('keydown', handleTab);
    firstElement?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleTab);
      document.body.style.overflow = '';
      previousActiveElement.current?.focus();
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen || !recipe) return null;

  const errorMessage = (error: unknown): string => {
    const code = error instanceof ApiClientError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'network_error') return 'Servizio non raggiungibile: riprova più tardi.';
    if (code === 'ai_consent_required') return 'Consenso AI richiesto.';
    if (code === 'ai_daily_limit_reached') return 'Limite giornaliero AI raggiunto.';
    return 'Operazione non riuscita. Riprova.';
  };

  const handleSaveRecipe = async () => {
    if (!verified || !csrfToken || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await saveAiRecipe(recipe as any, csrfToken);
      setError(null);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteRecipe = async () => {
    if (!verified || !csrfToken || isDeleting) return;
    if (!window.confirm('Eliminare definitivamente questa ricetta?')) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteAiRecipe(recipe.id, csrfToken);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleAddToShoppingList = () => {
    if (!verified) {
      setError('Devi aver effettuato l\'accesso per aggiungere alla lista spesa.');
      return;
    }
    const pantryRecipe = {
      id: recipe.id,
      title: recipe.title,
      ingredients: recipe.ingredients.map(i => ({
        ingredientId: i.name.toLowerCase().replace(/\s+/g, '-'),
        name: i.name,
        amount: i.amount,
        unit: '',
        optional: false,
      })),
    } as any;
    const added = addMissingRecipeIngredients(pantryRecipe, pantryLabels);
    if (added > 0) {
      setError(null);
      onClose();
    } else {
      setError('Tutti gli ingredienti sono già in dispensa o nella lista.');
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: recipe.title,
          text: `${recipe.description}\n\nTempo: ${recipe.time} | Porzioni: ${recipe.servings}`,
          url: window.location.href,
        });
      } catch {
        // User cancelled or error
      }
    } else {
      navigator.clipboard.writeText(window.location.href);
      setError('Link copiato negli appunti!');
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleStartCooking = () => {
    onClose();
    if (onStartCooking) onStartCooking(recipe);
  };

  if (!isOpen || !recipe) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="recipe-modal-title">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      
      <div 
        ref={modalRef}
        className="absolute bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:bottom-auto md:max-h-[90vh] md:max-w-2xl md:rounded-2xl bg-[var(--sc-cream)] border border-[var(--sc-peach-soft)] shadow-[var(--sc-shadow-lift)] animate-slide-up max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--sc-peach-soft)] sticky top-0 bg-[var(--sc-cream)]/95 backdrop-blur-sm z-10 rounded-t-2xl">
          <h2 id="recipe-modal-title" className="text-lg font-bold text-[var(--sc-ink)]">{recipe.emoji} {recipe.title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--sc-ink-faint)] hover:bg-[var(--sc-peach-soft)] transition-colors"
            aria-label="Chiudi"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 pb-20 max-h-[calc(90vh-80px)] overflow-y-auto">
          {/* Hero Image */}
          <div className="relative aspect-[16/9] rounded-2xl overflow-hidden mb-4" style={{ backgroundColor: 'var(--sc-peach-soft)' }}>
            <img
              src={recipe.image}
              alt={recipe.title}
              className="w-full h-full object-cover opacity-90"
              loading="lazy"
            />
            <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-1.5">
              {recipe.tags.map((tag) => (
                <Tag key={tag} variant="default">{tag}</Tag>
              ))}
            </div>
          </div>

          {/* Meta Info */}
          <div className="flex flex-wrap items-center gap-4 mb-4 text-sm text-[var(--sc-ink-soft)]">
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4" aria-hidden="true" />
              {recipe.time}
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="w-4 h-4" aria-hidden="true" />
              {recipe.servings} porzioni
            </span>
            {recipe.source === 'ai' && (
              <Tag variant="default">🤖 AI</Tag>
            )}
          </div>

          {/* Description */}
          {recipe.description && (
            <p className="text-[var(--sc-ink-soft)] leading-relaxed mb-4">{recipe.description}</p>
          )}

          {/* Diet & Allergens */}
          {(recipe.diets.length > 0 || recipe.allergens.length > 0) && (
            <div className="mb-4">
              {recipe.diets.length > 0 && (
                <div className="mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--sc-ink-faint)] mb-1">Dieta</p>
                  <div className="flex flex-wrap gap-1.5">
                    {recipe.diets.map((diet) => (
                      <Tag key={diet} variant="ready">{DIET_LABELS[diet] || diet}</Tag>
                    ))}
                  </div>
                </div>
              )}
              {recipe.allergens.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--sc-ink-faint)] mb-1">Allergeni</p>
                  <div className="flex flex-wrap gap-1.5">
                    {recipe.allergens.map((allergen) => (
                      <Tag key={allergen} variant="missing">{ALLERGEN_LABELS[allergen] || allergen}</Tag>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Ingredients */}
          <div className="mb-4">
            <h3 className="font-bold text-[var(--sc-ink)] mb-2">Ingredienti</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--sc-ink-soft)]">
              {recipe.ingredients.map((ingredient) => (
                <li key={`${recipe.id}-${ingredient.name}`}>{ingredient.amount} {ingredient.name}</li>
              ))}
            </ul>
          </div>

          {/* Steps */}
          <div className="mb-6">
            <h3 className="font-bold text-[var(--sc-ink)] mb-2">Procedimento</h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--sc-ink-soft)]">
              {recipe.steps.map((step, index) => (
                <li key={`${recipe.id}-step-${index}`}>{step}</li>
              ))}
            </ol>
          </div>

          {/* Error Toast */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-[var(--sc-coral-soft)] text-[var(--sc-terracotta)] text-sm" role="alert">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="space-y-3 pt-4 border-t border-[var(--sc-peach-soft)]">
            {/* Primary: Start Cooking */}
            <button
              type="button"
              onClick={handleStartCooking}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3 recipe-modal-action"
              style={{
                backgroundColor: 'var(--sc-terracotta)',
                color: 'var(--sc-cream)',
                borderRadius: '16px',
                fontWeight: 600,
                fontSize: '16px',
                border: 'none',
                cursor: 'pointer',
                boxShadow: 'var(--sc-shadow-card)',
              }}
            >
              <ChefHat className="w-5 h-5" aria-hidden="true" />
              Inizia cottura
            </button>

            {/* Secondary Actions Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {verified && recipe.source === 'ai' && (
                <>
                  <button
                    type="button"
                    onClick={handleSaveRecipe}
                    disabled={isSaving}
                    className="btn-secondary flex items-center justify-center gap-2 py-2 recipe-modal-action"
                    style={{
                      backgroundColor: 'var(--sc-cream)',
                      color: 'var(--sc-terracotta)',
                      border: '2px solid var(--sc-terracotta)',
                      borderRadius: '16px',
                      fontWeight: 600,
                      fontSize: '14px',
                    }}
                  >
                    <Save className="w-4 h-4" aria-hidden="true" />
                    {isSaving ? 'Salvo…' : 'Salva'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteRecipe}
                    disabled={isDeleting}
                    className="btn-secondary flex items-center justify-center gap-2 py-2 recipe-modal-action"
                    style={{
                      backgroundColor: 'var(--sc-cream)',
                      color: 'var(--sc-terracotta)',
                      border: '2px solid var(--sc-coral)',
                      borderRadius: '16px',
                      fontWeight: 600,
                      fontSize: '14px',
                    }}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    {isDeleting ? 'Elimino…' : 'Elimina'}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleAddToShoppingList}
                className="btn-secondary flex items-center justify-center gap-2 py-2 recipe-modal-action"
                style={{
                  backgroundColor: 'var(--sc-cream)',
                  color: 'var(--sc-terracotta)',
                  border: '2px solid var(--sc-terracotta)',
                  borderRadius: '16px',
                  fontWeight: 600,
                  fontSize: '14px',
                }}
              >
                <span className="w-4 h-4">🛒</span>
                Lista spesa
              </button>

              <button
                type="button"
                onClick={handleShare}
                className="btn-secondary flex items-center justify-center gap-2 py-2 recipe-modal-action"
                style={{
                  backgroundColor: 'var(--sc-cream)',
                  color: 'var(--sc-terracotta)',
                  border: '2px solid var(--sc-terracotta)',
                  borderRadius: '16px',
                  fontWeight: 600,
                  fontSize: '14px',
                }}
              >
                <Share2 className="w-4 h-4" aria-hidden="true" />
                Condividi
              </button>
            </div>

            {/* Link to full recipe page */}
            <Link
              to={`/recipes/${recipe.id}`}
              onClick={onClose}
              className="w-full text-center text-sm font-medium text-[var(--sc-terracotta)] hover:underline mt-2 block"
            >
              Visualizza pagina completa →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
});

RecipeDetailModal.displayName = 'RecipeDetailModal';