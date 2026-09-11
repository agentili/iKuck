import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <main className="mx-auto grid min-h-screen max-w-xl place-content-center px-4 py-12 text-center">
      <p className="text-6xl" aria-hidden="true">🍳</p>
      <h1 className="mt-5 text-4xl font-black text-gray-950">Ricetta non trovata</h1>
      <p className="mt-3 text-lg leading-relaxed text-gray-600">Questa ricetta non è presente nel catalogo.</p>
      <Link to="/" className="mx-auto mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-5 py-3 font-bold text-white hover:bg-emerald-800">
        <ArrowLeft size={18} aria-hidden="true" />
        Torna alla dispensa
      </Link>
    </main>
  );
}
