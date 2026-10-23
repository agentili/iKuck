import { Link } from 'react-router-dom';

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

const VARIANT_STYLE: Record<
  RecipeCardVariant,
  { label: string; border: string; background: string; text: string }
> = {
  salvata: { label: 'Salvata', border: 'border-emerald-200', background: 'bg-emerald-50', text: 'text-emerald-900' },
  ai: { label: 'AI', border: 'border-emerald-200', background: 'bg-emerald-50', text: 'text-emerald-900' },
  catalogo: { label: 'Catalogo', border: 'border-gray-200', background: 'bg-gray-50', text: 'text-gray-900' },
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
  const style = VARIANT_STYLE[variant];

  return (
    <article
      className={`rounded-[var(--ik-radius-panel)] border ${style.border} bg-white p-4`}
      style={{ boxShadow: 'var(--ik-shadow-card)' }}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 mb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-xl font-black text-gray-950">{title}</h3>
          <span className={`whitespace-nowrap rounded-full border-2 ${style.border} ${style.background} px-2.5 py-0.5 text-xs font-bold ${style.text}`}>
            {style.label}
          </span>
        </div>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-controls={detailsId}
            className="shrink-0 rounded-xl p-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
          >
            {isExpanded ? 'Nascondi dettagli' : 'Mostra dettagli'}
          </button>
        )}
      </div>
      {description && description.trim().length > 0 && (
        <p className="mb-3 text-sm leading-relaxed text-gray-600">{description}</p>
      )}
      {isExpanded && detailsId && (
        <div id={detailsId} className="space-y-3">
          {ingredients && ingredients.length > 0 && (
            <>
              <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">
                Ingredienti
              </h4>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                {ingredients.map((ingredient, index) => (
                  <li key={`${ingredient.name}-${index}`}>
                    <span>{ingredient.name}</span>
                    {showIngredientAmounts && ingredient.amount && (
                      <span className="ml-1 text-gray-500">{ingredient.amount}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {steps && steps.length > 0 && (
            <>
              <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">
                Procedimento
              </h4>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
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
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white"
        >
          Apri ricetta
        </Link>
      )}
    </article>
  );
}
