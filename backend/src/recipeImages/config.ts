import { z } from 'zod';
const schema = z.object({
  RECIPE_IMAGES_ENABLED: z.enum(['true', 'false']).default('false'),
  RECIPE_IMAGE_PROVIDER: z.enum(['openai', 'gemini']).optional(),
  RECIPE_IMAGE_MODEL: z.string().min(1).optional(),
  RECIPE_IMAGE_VISION_MODEL: z.string().min(1).optional(),
  RECIPE_IMAGE_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  PEXELS_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().optional(), GEMINI_API_KEY: z.string().optional(),
  RECIPE_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
});
export function imageConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const provider = value.RECIPE_IMAGE_PROVIDER ?? value.RECIPE_PROVIDER;
  const apiKey = provider === 'openai' ? value.OPENAI_API_KEY : value.GEMINI_API_KEY;
  const enabled = value.RECIPE_IMAGES_ENABLED === 'true';
  if (enabled && (!apiKey || !value.PEXELS_API_KEY || !value.RECIPE_IMAGE_MODEL || !value.RECIPE_IMAGE_VISION_MODEL)) {
    throw new Error('Recipe images require search credentials, image/vision models and provider credentials');
  }
  return { enabled, provider, apiKey: apiKey ?? '', searchKey: value.PEXELS_API_KEY ?? '', model: value.RECIPE_IMAGE_MODEL ?? '', visionModel: value.RECIPE_IMAGE_VISION_MODEL ?? '', dailyLimit: value.RECIPE_IMAGE_DAILY_LIMIT };
}
export type ImageConfig = ReturnType<typeof imageConfig>;
