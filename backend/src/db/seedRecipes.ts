import { query } from './connection';
import { logger } from '../utils/logger';

const categories = ['pasta', 'riso', 'zuppe', 'insalate', 'carne', 'pesce', 'verdure', 'uova'];

const catIngredients: Record<string, string[]> = {
  pasta: ['pasta', 'pomodoro', 'basilico', 'aglio', 'olio d oliva', 'parmigiano'],
  riso: ['riso', 'zafferano', 'burro', 'cipolla', 'brodo vegetale'],
  zuppe: ['fagioli', 'patate', 'carote', 'sedano', 'cipolla'],
  insalate: ['lattuga', 'pomodoro', 'mais', 'tonno', 'olive'],
  carne: ['pollo', 'rosmarino', 'limone', 'patate', 'vino bianco'],
  pesce: ['merluzzo', 'pomodorini', 'olive', 'capperi', 'prezzemolo'],
  verdure: ['zucchine', 'melanzane', 'peperoni', 'cipolla', 'olio d oliva'],
  uova: ['uova', 'pancetta', 'parmigiano', 'pepe', 'latte']
};

const generateRecipes = () => {
  const recipes: any[] = [];
  categories.forEach((cat) => {
    for (let i = 1; i <= 25; i++) {
      const ings = catIngredients[cat] || ['sale', 'pepe'];
      const recipeIngredients = ings.map(name => ({
        name,
        quantity: Math.floor(Math.random() * 100) + 1,
        unit: name === 'pomodoro' || name === 'uova' ? 'piece' : 'g',
        isOptional: Math.random() > 0.8
      }));

      recipes.push({
        title: `${cat.charAt(0).toUpperCase() + cat.slice(1)} alla casalinga ${i}`,
        description: `Un classico piatto di ${cat} preparato secondo la tradizione ${i}`,
        difficulty: Math.random() > 0.7 ? 'medium' : 'easy',
        preparation_time: Math.floor(Math.random() * 35) + 10,
        servings: Math.random() > 0.5 ? 2 : 4,
        ingredients: recipeIngredients,
        instructions: [
          { step: 1, description: `Preparare gli ingredienti per ${cat}` },
          { step: 2, description: 'Cuocere a fuoco lento' },
          { step: 3, description: 'Servire caldo' },
        ],
        tags: [cat, 'tradizionale', 'veloce'],
        image_url: null,
      });
    }
  });
  return recipes;
};

const seed = async () => {
  try {
    const recipes = generateRecipes();
    logger.info(`Starting seeding ${recipes.length} recipes...`);

    for (let i = 0; i < recipes.length; i += 50) {
      const batch = recipes.slice(i, i + 50);
      for (const r of batch) {
        await query(
          'INSERT INTO recipes (title, description, difficulty, preparation_time, servings, ingredients, instructions, tags, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING',
          [r.title, r.description, r.difficulty, r.preparation_time, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.instructions), JSON.stringify(r.tags), r.image_url]
        );
      }
      logger.info(`Seeded batch ${i / 50 + 1}`);
    }

    logger.info('Seeding completed successfully');
    process.exit(0);
  } catch (err) {
    logger.error('Seeding error', err);
    process.exit(1);
  }
};

seed();
