import KitchenArtwork from '../components/layout/KitchenArtwork';
import { usePersistenceStatusStore } from '../store/persistenceStatusStore';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { toDiaryPantryRecipe } from '../domain/diaryRecipes';
import { RECIPES } from '../domain/recipes';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Leaf, CookingPot } from 'lucide-react';
import { usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useActivityStore } from '../store/activityStore';
import { findRecipeSuggestions, createSeededRandom } from '../domain/suggestions';
import { aggregatePantryLots } from '../domain/pantryLots';
import LocalRecipeCard from '../components/suggestions/LocalRecipeCard';

export default function HomePage() {
  const statuses = usePersistenceStatusStore((state) => state.statuses);
  const hasStorageIssue = Object.values(statuses).some((status) => status.state === 'memory-only');
  const items = usePantryStore((state) => state.pantryItems);
  const lots = usePantryStore((state) => state.pantryLots);
  const staples = usePantryStore((state) => state.stapleIds);
  const profile = useDietProfileStore((state) => state.profile);
  const preferences = useActivityStore((state) => state.preferences);
  const events = useActivityStore((state) => state.events);
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const savedRecipes = useDinnerDiaryStore((state) => state.recipes);
  const addMissing = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const shoppingItems = useShoppingListStore((state) => state.items);
  useEffect(() => { void hydrateDinnerDiaryStore(); }, [scope]);
  const recipes = useMemo(() => [...RECIPES, ...savedRecipes.filter((recipe) => recipe.scope === scope).map(toDiaryPantryRecipe)], [savedRecipes, scope]);
  const suggestions = useMemo(() => findRecipeSuggestions({
    recipes, availableIds: [...items.filter((item) => item.known).map((item) => item.id), ...staples],
    allowOneMissing: true, dietProfile: profile, preferences, events,
    quantitySummaries: aggregatePantryLots(lots), random: createSeededRandom(0), limit: recipes.length,
  }), [items, staples, profile, preferences, events, lots, recipes]);
  const suggestionKey = JSON.stringify([scope, suggestions.map((suggestion) => [suggestion.recipe.id, suggestion.missingIngredientIds])]);
  const [selection, setSelection] = useState({ key: suggestionKey, offset: 0 });
  const offset = selection.key === suggestionKey ? selection.offset : 0;
  if (selection.key !== suggestionKey) setSelection({ key: suggestionKey, offset: 0 });
  const visibleSuggestions = suggestions.slice(offset, offset + 4);
  const shoppingIngredientIds = new Set(shoppingItems.filter((item) => !item.purchased).map((item) => item.ingredientId));
  return <main id="main-content" className="home-v2">
    {hasStorageIssue && <p role="alert" className="app-notice notice-error">Alcune modifiche non sono salvate sul dispositivo. <Link to="/pantry">Controlla il salvataggio e riprova</Link></p>}
    <section className="kitchen-hero"><div className="hero-copy"><div className="home-eyebrow"><Leaf size={18} aria-hidden="true" /> Meno sprechi, più gusto</div>
    <h1>Cosa portiamo <br /><span className="home-title-accent">a tavola?</span></h1>
    <p className="home-intro">Le cose buone iniziano da quello che hai già.</p>
    {items.length > 0 && <Link to="/pantry" className="hero-action">Apri la tua dispensa <ArrowRight size={18} aria-hidden="true" /></Link>}
    </div><div className="hero-art"><span className="art-label">Fatto in casa, fatto bene.</span><KitchenArtwork /><span className="art-seal">BUONO<br />OGNI GIORNO</span></div></section>
    {items.length === 0 ? <section className="home-welcome" aria-labelledby="welcome-title">
      <CookingPot size={48} strokeWidth={1.3} aria-hidden="true" />
      <h2 id="welcome-title">La tua prossima cena parte da qui.</h2>
      <p>Aggiungi il primo ingrediente. Alle idee pensiamo noi.</p>
      <Link className="primary-action" to="/pantry">Aggiungi un ingrediente <ArrowRight size={18} aria-hidden="true" /></Link>
    </section> : <>
      <section aria-labelledby="tonight-title"><div className="section-heading"><h2 id="tonight-title">L’idea di oggi</h2><Link to="/pantry">{items.length} ingredienti in dispensa <ArrowRight size={16} aria-hidden="true" /></Link></div>
      {suggestions.length > 0 ? <><div className="home-recipes">{visibleSuggestions.map((suggestion) => <LocalRecipeCard key={suggestion.recipe.id} suggestion={suggestion} missingIngredientInShoppingList={suggestion.missingIngredientIds.length > 0 && suggestion.missingIngredientIds.every((id) => shoppingIngredientIds.has(id))} onAddMissingIngredient={(choice) => addMissing(choice.recipe, [...items.filter((item) => item.known).map((item) => item.id), ...staples])} />)}</div>
      {suggestions.length > 4 && <div className="home-ideas-controls"><p className="home-suggestion-status" role="status">Idee {offset + 1}–{Math.min(offset + 4, suggestions.length)} di {suggestions.length}</p><button className="home-more-ideas" type="button" onClick={() => setSelection({ key: suggestionKey, offset: offset + 4 >= suggestions.length ? 0 : offset + 4 })}>Altre idee <ArrowRight size={18} aria-hidden="true" /></button></div>}</> : <div className="home-welcome"><h3>Ci manca ancora qualcosa.</h3><p>Aggiungi altri ingredienti per trovare una ricetta adatta alle tue preferenze.</p><Link className="primary-action" to="/pantry">Completa la dispensa</Link></div>}</section>
      <Link className="home-catalog" to="/recipes">Tutte le ricette <ArrowRight size={20} aria-hidden="true" /></Link>
      <div className="kitchen-shortcuts"><Link to="/pantry"><span>01 / ORGANIZZA</span><strong>La tua dispensa <ArrowRight size={16} aria-hidden="true" /></strong><small>{items.length} ingredienti, tante possibilità.</small></Link><Link to="/recipes"><span>02 / LASCIATI ISPIRARE</span><strong>Il ricettario <ArrowRight size={16} aria-hidden="true" /></strong><small>Trova il tuo prossimo piatto del cuore.</small></Link><Link to="/shopping-list"><span>03 / PORTA A CASA</span><strong>La lista della spesa <ArrowRight size={16} aria-hidden="true" /></strong><small>Solo quello che serve, tutto in un posto.</small></Link></div>
    </>}
    <p className="home-footnote">La tua dispensa resta con te. Anche senza connessione.</p>
  </main>;
}
