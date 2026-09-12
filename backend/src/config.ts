import { z } from 'zod';

export interface ProviderConfig {
  resendApiKey?: string;
  resendFrom?: string;
  usdaApiKey?: string;
  openAiApiKey?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  appOrigin: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  providers: ProviderConfig;
  nodeEnvironment: 'development' | 'test' | 'production';
}

const developmentDefaults = {
  DATABASE_URL: 'postgres://ikuck:ikuck@127.0.0.1:5432/ikuck',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'development-session-secret-not-for-production',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'debug',
} as const;

const requiredEnvironmentValue = (name: string) => z
  .string({ error: `${name} is required` })
  .min(1, `${name} is required`);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: requiredEnvironmentValue('DATABASE_URL'),
  REDIS_URL: requiredEnvironmentValue('REDIS_URL'),
  SESSION_SECRET: requiredEnvironmentValue('SESSION_SECRET'),
  APP_ORIGIN: z.string().url('APP_ORIGIN must be a valid URL'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().email().optional(),
  USDA_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

export const loadConfig = (environment: NodeJS.ProcessEnv): AppConfig => {
  const nodeEnvironment = environment.NODE_ENV ?? 'development';
  const source = nodeEnvironment === 'development'
    ? { ...developmentDefaults, ...environment, NODE_ENV: nodeEnvironment }
    : environment;
  const parsed = environmentSchema.parse(source);

  if (parsed.NODE_ENV === 'production' && parsed.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    sessionSecret: parsed.SESSION_SECRET,
    appOrigin: parsed.APP_ORIGIN,
    logLevel: parsed.LOG_LEVEL,
    providers: {
      resendApiKey: parsed.RESEND_API_KEY,
      resendFrom: parsed.RESEND_FROM,
      usdaApiKey: parsed.USDA_API_KEY,
      openAiApiKey: parsed.OPENAI_API_KEY,
    },
    nodeEnvironment: parsed.NODE_ENV,
  };
};
