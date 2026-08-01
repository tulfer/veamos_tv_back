import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_DATABASE_URL: z.string().optional(),

  JWT_SECRET: z.string().default('change-me-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  REDIS_URL: z.string().optional(),

  PUBLIC_BASE_URL: z.string().optional(),

  // Fallback de extracción en Cloud Run (último recurso cuando la extracción
  // local/HTTP falla). App Hosting es el principal; solo se usa Cloud Run si
  // FALLBACK_EXTRACT_URL está configurada y la extracción normal no dio URL.
  FALLBACK_EXTRACT_URL: z.string().optional(),
  FALLBACK_EXTRACT_KEY: z.string().optional(),

  SCRAPE_INTERVAL_MINUTES: z.coerce.number().default(30),
});

const parsed = envSchema.safeParse(process.env);
const env = parsed.success ? parsed.data : envSchema.parse({});

if (!parsed.success) {
  const flat = parsed.error.flatten().fieldErrors;
  process.stderr.write(`WARNING: Invalid env vars, using defaults: ${JSON.stringify(flat)}\n`);
}

export { env };
