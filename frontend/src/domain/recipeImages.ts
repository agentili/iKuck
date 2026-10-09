export interface RecipeImageAsset {
  src: string;
  width: number;
  height: number;
  alt: string;
  illustrative: boolean;
  author: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
}

/** Verified local-only recipe artwork. Illustrative photos are labelled in the UI. */
export const RECIPE_IMAGES: Readonly<Record<string, RecipeImageAsset>> = {
  'uova-al-pomodoro': {
    src: '/recipe-images/uova-al-pomodoro.webp',
    width: 720,
    height: 720,
    alt: 'Uova cotte in una salsa di pomodoro in padella; foto illustrativa, non una riproduzione esatta della ricetta.',
    illustrative: true,
    author: 'Alex Bayev',
    sourceUrl: 'https://unsplash.com/photos/a-skillet-with-eggs-and-tomatoes-on-a-table-aDccXHMCH2c',
    license: 'Unsplash License',
    licenseUrl: 'https://unsplash.com/license',
  },
};
