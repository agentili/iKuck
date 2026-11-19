import type { GeneratedRecipeDraft, PantryIngredientReview } from "@ikuck/shared/contracts";
import { ALLERGEN_LABELS } from "../../domain/dietary";

export function GenerateCandidatePreview({ recipe, ingredientReview, onSave, onDiscard, isSaving }: { recipe: GeneratedRecipeDraft; ingredientReview?: PantryIngredientReview; onSave: () => void; onDiscard: () => void; isSaving: boolean }) {
  return (
    <div aria-busy={isSaving} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <h3 className="text-lg font-bold text-[var(--ik-ink)]">{recipe.title}</h3>
        <p className="mt-4 text-sm text-[var(--ik-ink-muted)]">{recipe.description}</p>
        {ingredientReview !== undefined && <IngredientReviewSummary review={ingredientReview} />}
        <div className="mt-4">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Ingredienti</h4>
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-[var(--ik-ink)]">
            {recipe.ingredients.map((ing, i) => (
              <li key={i}>{ing.name} {ing.amount}</li>
            ))}
          </ul>
        </div>
        <div className="mt-4">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Procedimento</h4>
          <ol className="mt-1 list-inside list-decimal space-y-1 text-sm text-[var(--ik-ink)]">
            {recipe.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
      {isSaving && (
        <p role="status" className="mt-4 shrink-0 text-sm text-[var(--ik-ink-muted)]">
          Salvataggio in corso: attendi la risposta prima di chiudere.
        </p>
      )}
      <div className="mt-5 flex shrink-0 gap-3 border-t border-[var(--ik-border)] pt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving}
          className="flex-1 min-h-11 rounded-xl bg-[var(--ik-basil-dark)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil)] disabled:opacity-50"
        >
          Salva nel ricettario
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={isSaving}
          className="flex-1 min-h-11 rounded-xl border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:bg-[var(--ik-mist)]"
        >
          Scarta
        </button>
      </div>
    </div>
  );
}

export function IngredientReviewSummary({ review }: { review: PantryIngredientReview }) {
  const count = review.consideredIngredients.length;
  const usedCount = review.assessments.filter((item) => item.disposition === 'used').length;
  const notSelectedCount = review.assessments.filter((item) => item.disposition === 'not_selected').length;
  const excludedCount = review.assessments.filter((item) => item.disposition === 'excluded').length;
  const explanation = (item: PantryIngredientReview['excludedIngredients'][number]): string => {
    switch (item.reason) {
      case 'composition_unverified': return 'composizione non verificabile dal solo nome';
      case 'diet_incompatible': return 'non compatibile con la dieta selezionata';
      case 'excluded_allergen': return `allergeni esclusi dal profilo: ${item.allergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}`;
    }
  };
  const uncertainUsed = review.assessments.filter((item) => item.disposition === 'used' && item.allergenCoverage !== 'complete');

  return (
    <div className="mt-4 rounded-xl border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm text-[var(--ik-ink-muted)]">
      {count > 0 && (
        <p>
          Ingredienti valutati: {count}. Usati nella proposta: {usedCount}; non usati nella proposta: {notSelectedCount}; esclusi per sicurezza: {excludedCount}.
        </p>
      )}
      {uncertainUsed.map((item, index) => (
        <div key={`${item.inputIndex}-${index}`} className="mt-2">
          <p>{item.warning ?? (item.evidence === 'provider_declared'
            ? "Composizione proposta, non verifica del prodotto: controlla l'etichetta. L'assenza di altri allergeni non è verificata."
            : "Composizione non completamente verificata dal solo nome: controlla l'etichetta. L'assenza di altri allergeni non è verificata.")}</p>
          {item.presentAllergens.length > 0 && (
            <p>{item.evidence === 'provider_declared' ? 'Allergeni dichiarati nella proposta' : 'Allergeni implicati dal nome'}: {item.presentAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
          {item.possibleAllergens.length > 0 && (
            <p>Rischio possibile per {item.name}: {item.possibleAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
        </div>
      ))}
      {(review.recipeIngredientWarnings ?? []).map((item) => (
        <div key={`recipe-ingredient-${item.ingredientIndex}`} className="mt-2">
          <p>{item.name}: {item.warning}</p>
          {item.presentAllergens.length > 0 && (
            <p>Allergeni implicati dal nome: {item.presentAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
          {item.possibleAllergens.length > 0 && (
            <p>Rischio possibile per {item.name}: {item.possibleAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
        </div>
      ))}
      {review.excludedIngredients.length > 0 && (
        <ul className="mt-2 space-y-1">
          {review.excludedIngredients.map((item, index) => (
            <li key={`${item.name}-${index}`}><strong>{item.name}</strong>: {explanation(item)}.</li>
          ))}
        </ul>
      )}
    </div>
  );
}
