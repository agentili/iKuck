import { z } from 'zod';

const schema = z.object({
  RECIPE_IMAGES_ENABLED: z.enum(['true', 'false']).default('false'),
  RECIPE_IMAGE_MODEL: z.string().trim().min(1).optional(),
  RECIPE_IMAGE_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
});

export function imageConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(Object.fromEntries(Object.entries(env).filter(([, item]) => item !== '')));
  const enabled = value.RECIPE_IMAGES_ENABLED === 'true';
  if (enabled && (!value.OPENAI_API_KEY || !value.RECIPE_IMAGE_MODEL)) {
    throw new Error('Recipe images require OpenAI credentials and an image model');
  }
  return {
    enabled,
    provider: 'openai' as const,
    apiKey: value.OPENAI_API_KEY ?? '',
    model: value.RECIPE_IMAGE_MODEL ?? '',
    dailyLimit: value.RECIPE_IMAGE_DAILY_LIMIT,
  };
}

export type ImageConfig = ReturnType<typeof imageConfig>;
