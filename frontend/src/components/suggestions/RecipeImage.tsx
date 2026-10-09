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
        <div className="ik-recipe-image-fallback" role="img" aria-label={`Foto non disponibile per ${recipeTitle}`}>
          <span aria-hidden="true">Foto non disponibile</span>
        </div>
      )}
      {asset !== undefined && !failed && (
        <figcaption>
          {asset.illustrative ? 'Foto illustrativa' : 'Foto della ricetta'} · {asset.author} · Unsplash
        </figcaption>
      )}
    </figure>
  );
}
