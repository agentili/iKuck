import { z } from 'zod';

export interface ProviderConfig {
  resendApiKey?: string;
  resendFrom?: string;
  resendTimeoutMs?: number;
  usdaApiKey?: string;
  usdaTimeoutMs?: number;
  openAiApiKey?: string;
  openAiModel?: string;
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

const optionalEnvironmentEmail = () => z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().email().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: requiredEnvironmentValue('DATABASE_URL'),
  REDIS_URL: requiredEnvironmentValue('REDIS_URL'),
  APP_ORIGIN: z.string().url('APP_ORIGIN must be a valid URL'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SYNC_MAX_CLIENT_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  RESEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  USDA_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(8000),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
  TRUST_PROXY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  RESEND_API_KEY: optionalEnvironmentString(),
  RESEND_FROM_EMAIL: optionalEnvironmentEmail(),
  RESEND_FROM: optionalEnvironmentEmail(),
  USDA_API_KEY: optionalEnvironmentString(),
  OPENAI_API_KEY: optionalEnvironmentString(),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.5'),
  GOOGLE_CLIENT_ID: optionalEnvironmentString(),
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
      resendApiKey: parsed.RESEND_API_KEY,
      resendFrom: parsed.RESEND_FROM_EMAIL ?? parsed.RESEND_FROM,
      resendTimeoutMs: parsed.RESEND_TIMEOUT_MS,
      usdaApiKey: parsed.USDA_API_KEY,
      usdaTimeoutMs: parsed.USDA_TIMEOUT_MS,
      openAiApiKey: parsed.OPENAI_API_KEY,
      openAiModel: parsed.OPENAI_MODEL,
      openAiTimeoutMs: parsed.OPENAI_TIMEOUT_MS,
    },
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    trustProxy,
    nodeEnvironment: parsed.NODE_ENV,
  };
};
