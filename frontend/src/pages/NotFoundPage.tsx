import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

interface NotFoundPageProps {
  resource?: 'page' | 'recipe';
}

export default function NotFoundPage({ resource = 'recipe' }: NotFoundPageProps) {
  const mainRef = useRef<HTMLElement>(null);
  const isRecipe = resource === 'recipe';

  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  return (
    <main ref={mainRef} id="main-content" tabIndex={-1} className="ik-page mx-auto grid min-h-screen w-full max-w-3xl !max-w-3xl place-content-center px-4 py-12 text-[var(--ik-ink)] sm:px-6">
      <section aria-labelledby="not-found-title" className="ik-surface ik-profile-surface w-full border-2 p-6 text-center sm:p-10">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--ik-yolk-soft)] text-4xl" aria-hidden="true">🍳</div>
        <p className="ik-eyebrow mt-5">{isRecipe ? 'Catalogo' : 'Percorso non disponibile'}</p>
        <h1 id="not-found-title" className="mt-1 text-[clamp(1.6rem,5.6vw,2.8rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">{isRecipe ? 'Ricetta non trovata' : 'Pagina non trovata'}</h1>
        <p className="mx-auto mt-3 max-w-lg text-base leading-relaxed text-[var(--ik-ink-muted)] sm:text-lg">
          {isRecipe ? 'Questa ricetta non è presente nel catalogo.' : 'L’indirizzo richiesto non corrisponde a una pagina disponibile.'}
        </p>
        <Link to={isRecipe ? '/recipes' : '/'} className="ik-button-primary mx-auto mt-7 inline-flex min-h-12 max-w-full items-center justify-center gap-2 px-5 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">
          <ArrowLeft size={18} aria-hidden="true" />
          {isRecipe ? 'Torna alle ricette' : 'Torna alla home'}
        </Link>
      </section>
    </main>
  );
}
