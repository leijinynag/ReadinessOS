import { z } from 'zod';

const localDatabaseUrl =
  'postgresql://readinessos:readinessos@localhost:5433/readinessos?schema=public';

const envSchema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(16),
  AUTH_DEMO_EMAIL: z.email(),
  AUTH_DEMO_PASSWORD: z.string().min(12),
  DEMO_LOGIN_ENABLED: z.enum(['true', 'false']),
  CRON_SECRET: z.string().min(16).optional(),
  EVE_API_KEY: z.string().optional(),
  EVE_BASE_URL: z.url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
});

const rawEnv = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    (process.env.NODE_ENV === 'production' ? undefined : localDatabaseUrl),
  AUTH_SECRET:
    process.env.AUTH_SECRET ??
    (process.env.NODE_ENV === 'production'
      ? undefined
      : 'development-only-auth-secret-change-before-production'),
  AUTH_DEMO_EMAIL: process.env.AUTH_DEMO_EMAIL ?? 'demo@readinessos.local',
  AUTH_DEMO_PASSWORD: process.env.AUTH_DEMO_PASSWORD ?? 'local-demo-password',
  DEMO_LOGIN_ENABLED: process.env.DEMO_LOGIN_ENABLED ?? 'true',
  CRON_SECRET: process.env.CRON_SECRET,
  EVE_API_KEY: process.env.EVE_API_KEY,
  EVE_BASE_URL: process.env.EVE_BASE_URL,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  SENTRY_DSN: process.env.SENTRY_DSN,
};

export const env = envSchema.parse(rawEnv);
