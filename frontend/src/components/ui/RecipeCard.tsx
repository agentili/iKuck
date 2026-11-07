import { Link } from 'react-router-dom';
import { Badge } from '../../components/shared';

type RecipeCardVariant = 'salvata' | 'ai' | 'catalogo';

interface RecipeIngredient {
  name: string;
  amount?: string;
}

interface RecipeCardProps {
  variant: RecipeCardVariant;
  title: string;
  description?: string;
  ingredients?: ReadonlyArray<RecipeIngredient>;
  showIngredientAmounts?: boolean;
  steps?: ReadonlyArray<string>;
  isExpanded?: boolean;
  onToggle?: () => void;
  detailsId?: string;
  openHref?: string;
  openAriaLabel?: string;
}

const VARIANT_BADGE: Record<RecipeCardVariant, { label: string; variant: 'primary' | 'accent' | 'neutral' }> = {
  salvata: { label: 'Salvata', variant: 'primary' },
  ai: { label: 'AI', variant: 'accent' },
  catalogo: { label: 'Catalogo', variant: 'neutral' },
};

export default function RecipeCard({
  variant,
  title,
  description,
  ingredients,
  showIngredientAmounts = false,
  steps,
  isExpanded = false,
  onToggle,
  detailsId,
  openHref,
  openAriaLabel,
}: RecipeCardProps) {
  const badge = VARIANT_BADGE[variant];

  return (
    <article
      className="ik-card p-4"
      data-availability={variant === 'catalogo' ? 'ready' : 'ready'}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-xl font-black text-[var(--color-text)]">{title}</h3>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-controls={detailsId}
            className="shrink-0 rounded-xl p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            {isExpanded ? 'Nascondi dettagli' : 'Mostra dettagli'}
          </button>
        )}
      </div>
      {description && description.trim().length > 0 && (
        <p className="mb-3 text-sm leading-relaxed text-[var(--color-text-muted)]">{description}</p>
      )}
      {isExpanded && detailsId && (
        <div id={detailsId} className="space-y-3">
          {ingredients && ingredients.length > 0 && (
            <>
              <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                Ingredienti
              </h4>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-text)]">
                {ingredients.map((ingredient, index) => (
                  <li key={`${ingredient.name}-${index}`}>
                    <span>{ingredient.name}</span>
                    {showIngredientAmounts && ingredient.amount && (
                      <span className="ml-1 text-[var(--color-text-muted)]">{ingredient.amount}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {steps && steps.length > 0 && (
            <>
              <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                Procedimento
              </h4>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--color-text)]">
                {steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
      {openHref && (
        <Link
          to={openHref}
          aria-label={openAriaLabel ?? `Apri ${title}`}
          className="ik-button-secondary mt-3 min-h-11 w-full sm:w-auto"
        >
          Apri ricetta
        </Link>
      )}
    </article>
  );
}