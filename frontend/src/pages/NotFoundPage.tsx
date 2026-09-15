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
    <main ref={mainRef} id="main-content" tabIndex={-1} className="mx-auto grid min-h-screen max-w-xl place-content-center px-4 py-12 text-center">
      <p className="text-6xl" aria-hidden="true">🍳</p>
      <h1 className="mt-5 text-4xl font-black text-gray-950">{isRecipe ? 'Ricetta non trovata' : 'Pagina non trovata'}</h1>
      <p className="mt-3 text-lg leading-relaxed text-gray-600">
        {isRecipe ? 'Questa ricetta non è presente nel catalogo.' : 'L’indirizzo richiesto non corrisponde a una pagina disponibile.'}
      </p>
      <Link to="/" className="mx-auto mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-5 py-3 font-bold text-white hover:bg-emerald-800">
        <ArrowLeft size={18} aria-hidden="true" />
        {isRecipe ? 'Torna alla dispensa' : 'Torna alla home'}
      </Link>
    </main>
  );
}
