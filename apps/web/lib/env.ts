import { z } from 'zod';

const localDatabaseUrl =
  'postgresql://readinessos:readinessos@localhost:5433/readinessos?schema=public';

const envSchema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(16),
  AUTH_DEMO_EMAIL: z.email(),
  AUTH_DEMO_PASSWORD: z.string().min(12),
  DEMO_LOGIN_ENABLED: z.enum(['true', 'false']),
  GUEST_DEMO_ENABLED: z.enum(['true', 'false']),
  GUEST_DEMO_MAX_CREATIONS_PER_DAY: z.coerce.number().int().min(1).max(100).default(3),
  GUEST_DEMO_RUN_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  GUEST_DEMO_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  AGENT_MAX_TURNS_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(20),
  AGENT_MAX_TOKENS_PER_RUN: z.coerce.number().int().min(1).max(10_000_000).default(40_000),
  AGENT_MAX_TOOL_STEPS_PER_RUN: z.coerce.number().int().min(1).max(100_000).default(100),
  AGENT_MAX_SUBAGENT_STEPS_PER_RUN: z.coerce.number().int().min(0).max(100_000).default(0),
  AGENT_MAX_COST_MICRO_USD_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(2_000_000),
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
  GUEST_DEMO_ENABLED: process.env.GUEST_DEMO_ENABLED ?? 'true',
  GUEST_DEMO_MAX_CREATIONS_PER_DAY: process.env.GUEST_DEMO_MAX_CREATIONS_PER_DAY,
  GUEST_DEMO_RUN_MINUTES: process.env.GUEST_DEMO_RUN_MINUTES,
  GUEST_DEMO_RETENTION_HOURS: process.env.GUEST_DEMO_RETENTION_HOURS,
  AGENT_MAX_TURNS_PER_RUN: process.env.AGENT_MAX_TURNS_PER_RUN,
  AGENT_MAX_TOKENS_PER_RUN: process.env.AGENT_MAX_TOKENS_PER_RUN,
  AGENT_MAX_TOOL_STEPS_PER_RUN: process.env.AGENT_MAX_TOOL_STEPS_PER_RUN,
  AGENT_MAX_SUBAGENT_STEPS_PER_RUN: process.env.AGENT_MAX_SUBAGENT_STEPS_PER_RUN,
  AGENT_MAX_COST_MICRO_USD_PER_RUN: process.env.AGENT_MAX_COST_MICRO_USD_PER_RUN,
  CRON_SECRET: process.env.CRON_SECRET,
  EVE_API_KEY: process.env.EVE_API_KEY,
  EVE_BASE_URL: process.env.EVE_BASE_URL,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  SENTRY_DSN: process.env.SENTRY_DSN,
};

export const env = envSchema.parse(rawEnv);
