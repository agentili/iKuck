import { useEffect, useState } from 'react';
import { RECIPE_IMAGES } from '../../domain/recipeImages';

interface RecipeImageProps {
  recipeId: string;
  recipeTitle: string;
  variant?: 'card' | 'detail';
}

export default function RecipeImage({ recipeId, recipeTitle, variant = 'card' }: RecipeImageProps) {
  const asset = RECIPE_IMAGES[recipeId];
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [recipeId]);

  return (
    <figure className={`ik-recipe-image ik-recipe-image--${variant}`} aria-label={`Immagine per ${recipeTitle}`}>
      {asset !== undefined && !failed ? (
        <img
          src={asset.src}
          width={asset.width}
          height={asset.height}
          alt={asset.alt}
          loading={variant === 'card' ? 'lazy' : 'eager'}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="ik-recipe-image-fallback" role="img" aria-label={`Illustrazione per ${recipeTitle}`}>
          <svg viewBox="0 0 720 288" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <rect width="720" height="288" className="ik-recipe-illustration-background" />
            <path d="M0 226c95-42 171-32 264 1 84 30 164 27 245-3 79-29 143-29 211-2v66H0z" className="ik-recipe-illustration-ground" />
            <ellipse cx="367" cy="170" rx="191" ry="92" className="ik-recipe-illustration-plate" />
            <ellipse cx="367" cy="164" rx="154" ry="65" className="ik-recipe-illustration-base" />
            <path d="M253 153c42-33 89-20 119 1 28 20 57 18 84-4 31-25 72-25 111 4-22 39-69 61-127 61-85 0-150-20-187-62z" className="ik-recipe-illustration-main" />
            <circle cx="330" cy="151" r="24" className="ik-recipe-illustration-egg" />
            <circle cx="398" cy="171" r="23" className="ik-recipe-illustration-egg" />
            <path d="M313 132c-4-18 9-29 22-20 11 8 5 21-6 23m63 14c-5-17 8-29 21-20 11 8 5 21-6 24" className="ik-recipe-illustration-herb" />
            <path d="M214 105c15-34 39-37 51-23 10 12-3 28-25 31m266 17c19-39 47-41 59-24 9 13-6 29-31 31" className="ik-recipe-illustration-herb" />
            <circle cx="227" cy="188" r="9" className="ik-recipe-illustration-spice" />
            <circle cx="514" cy="113" r="8" className="ik-recipe-illustration-spice" />
            <path d="M282 230h169" className="ik-recipe-illustration-rule" />
          </svg>
          <span aria-hidden="true">Illustrazione</span>
        </div>
      )}
      {asset !== undefined && !failed ? (
        <figcaption>
          {asset.illustrative ? 'Foto illustrativa' : 'Foto della ricetta'} · {asset.author} · Unsplash
        </figcaption>
      ) : <figcaption>Illustrazione della ricetta</figcaption>}
    </figure>
  );
}
