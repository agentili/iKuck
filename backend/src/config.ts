import { z } from 'zod';
import { BRING_LIST_ID_MAX_LENGTH } from '@ikuck/shared/bring';

export interface ProviderConfig {
  recipeProvider?: 'openai' | 'gemini';
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  emailFrom?: string;
  smtpTimeoutMs?: number;
  usdaApiKey?: string;
  usdaTimeoutMs?: number;
  openAiApiKey?: string;
  openAiModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  openAiTimeoutMs?: number;
}

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  appOrigin: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  syncMaxClientClockSkewMs: number;
  providers: ProviderConfig;
  googleClientId?: string;
  trustProxy?: string | string[];
  nodeEnvironment: 'development' | 'test' | 'production';
  s2sDinnerContextEnabled: boolean;
  bringEnabled: boolean;
  bringTokenEncryptionKey?: string;
  bringTestListId?: string;
  bringAllowedListIds: readonly string[];
}

const developmentDefaults = {
  DATABASE_URL: 'postgres://ikuck:ikuck@127.0.0.1:5432/ikuck',
  REDIS_URL: 'redis://127.0.0.1:6379',
  APP_ORIGIN: 'http://localhost:5173',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'debug',
} as const;

const requiredEnvironmentValue = (name: string) => z
  .string({ error: `${name} is required` })
  .min(1, `${name} is required`);

const optionalEnvironmentString = () => z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);

// Accepts both `sender@example.com` and `Display Name <sender@example.com>`.
const SENDER_PATTERN = /^[^<>]*<[^<>]+@[^<>]+\.[^<>]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s]+$/;

const optionalEnvironmentSender = () => z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).regex(SENDER_PATTERN, 'EMAIL_FROM must be an email address').optional(),
);

export const BRING_ALLOWED_LIST_IDS_MAX_ENTRIES = 50;

// `undefined` and an empty value mean "every list of the connected account is allowed".
// `null` means the configured value is invalid and must fail configuration loading.
export const parseBringAllowedListIds = (value: string | undefined): string[] | null => {
  if (value === undefined) return [];
  const entries = [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  if (entries.length > BRING_ALLOWED_LIST_IDS_MAX_ENTRIES) return null;
  return entries.some((entry) => entry.length > BRING_LIST_ID_MAX_LENGTH) ? null : entries;
};

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RECIPE_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
  DATABASE_URL: requiredEnvironmentValue('DATABASE_URL'),
  REDIS_URL: requiredEnvironmentValue('REDIS_URL'),
  APP_ORIGIN: z.string().url('APP_ORIGIN must be a valid URL'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SYNC_MAX_CLIENT_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  USDA_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
  TRUST_PROXY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  SMTP_HOST: optionalEnvironmentString(),
  SMTP_PORT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.coerce.number().int().min(1).max(65535).default(587),
  ),
  SMTP_USER: optionalEnvironmentString(),
  SMTP_PASS: optionalEnvironmentString(),
  EMAIL_FROM: optionalEnvironmentSender(),
  SMTP_TIMEOUT_MS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.coerce.number().int().min(100).max(120000).default(10000),
  ),
  USDA_API_KEY: optionalEnvironmentString(),
  OPENAI_API_KEY: optionalEnvironmentString(),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.5'),
  GEMINI_API_KEY: optionalEnvironmentString(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
  GOOGLE_CLIENT_ID: optionalEnvironmentString(),
  S2S_DINNER_CONTEXT_ENABLED: z.enum(['true', 'false']).default('false'),
  BRING_ENABLED: z.enum(['true', 'false']).default('false'),
  BRING_TOKEN_ENCRYPTION_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'Bring encryption key must be 32 bytes in hex').optional(),
  ),
  BRING_TEST_LIST_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().trim().min(1).max(BRING_LIST_ID_MAX_LENGTH).optional(),
  ),
  BRING_ALLOWED_LIST_IDS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
}).superRefine((value, context) => {
  if (value.BRING_ENABLED === 'true' && value.BRING_TOKEN_ENCRYPTION_KEY === undefined) {
    context.addIssue({ code: 'custom', path: ['BRING_TOKEN_ENCRYPTION_KEY'], message: 'Bring encryption key is required when Bring is enabled' });
  }
  if (value.BRING_ENABLED === 'true' && value.BRING_TEST_LIST_ID === undefined) {
    context.addIssue({ code: 'custom', path: ['BRING_TEST_LIST_ID'], message: 'Bring test list is required when Bring is enabled' });
  }
  if (value.BRING_ALLOWED_LIST_IDS !== undefined && parseBringAllowedListIds(value.BRING_ALLOWED_LIST_IDS) === null) {
    context.addIssue({
      code: 'custom',
      path: ['BRING_ALLOWED_LIST_IDS'],
      message: `Bring allowed list ids must be at most ${BRING_ALLOWED_LIST_IDS_MAX_ENTRIES} comma-separated ids of 1-${BRING_LIST_ID_MAX_LENGTH} characters`,
    });
  }
});

export const loadConfig = (environment: NodeJS.ProcessEnv): AppConfig => {
  const nodeEnvironment = environment.NODE_ENV ?? 'development';
  const source = nodeEnvironment === 'development'
    ? { ...developmentDefaults, ...environment, NODE_ENV: nodeEnvironment }
    : environment;
  const parsed = environmentSchema.parse(source);
  const configuredProxies = parsed.TRUST_PROXY?.split(',').map((value) => value.trim()).filter(Boolean);
  const trustProxy = configuredProxies === undefined || configuredProxies.length === 0
    ? undefined
    : configuredProxies.length === 1
      ? configuredProxies[0]
      : configuredProxies;

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    appOrigin: parsed.APP_ORIGIN,
    logLevel: parsed.LOG_LEVEL,
    syncMaxClientClockSkewMs: parsed.SYNC_MAX_CLIENT_CLOCK_SKEW_SECONDS * 1000,
    providers: {
      recipeProvider: parsed.RECIPE_PROVIDER,
      smtpHost: parsed.SMTP_HOST,
      smtpPort: parsed.SMTP_PORT,
      smtpUser: parsed.SMTP_USER,
      smtpPass: parsed.SMTP_PASS,
      emailFrom: parsed.EMAIL_FROM,
      smtpTimeoutMs: parsed.SMTP_TIMEOUT_MS,
      usdaApiKey: parsed.USDA_API_KEY,
      usdaTimeoutMs: parsed.USDA_TIMEOUT_MS,
      openAiApiKey: parsed.OPENAI_API_KEY,
      openAiModel: parsed.OPENAI_MODEL,
      geminiApiKey: parsed.GEMINI_API_KEY,
      geminiModel: parsed.GEMINI_MODEL,
      openAiTimeoutMs: parsed.OPENAI_TIMEOUT_MS,
    },
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    trustProxy,
    nodeEnvironment: parsed.NODE_ENV,
    s2sDinnerContextEnabled: parsed.S2S_DINNER_CONTEXT_ENABLED === 'true',
    bringEnabled: parsed.BRING_ENABLED === 'true',
    bringTokenEncryptionKey: parsed.BRING_TOKEN_ENCRYPTION_KEY,
    bringTestListId: parsed.BRING_TEST_LIST_ID,
    bringAllowedListIds: parseBringAllowedListIds(parsed.BRING_ALLOWED_LIST_IDS) ?? [],
  };
};
