import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),

  // Supabase (Postgres) — reemplaza Firestore como capa de datos
  DATABASE_URL: z.string().optional(),
  // Secreto de firma de los tokens de Supabase Auth (validación en /auth/supabase)
  SUPABASE_JWT_SECRET: z.string().optional(),

  // Firebase admin — SOLO se usan para migrar Firestore -> Supabase desde el
  // dashboard (/sync/migrate-firestore-to-supabase). No se usan en runtime.
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
let env: z.infer<typeof envSchema>;

if (parsed.success) {
  env = parsed.data;
} else {
  // No tirar la config entera (y perder DATABASE_URL) por UN campo inválido
  // (p.ej. NODE_ENV mal escrito). Se parte de los defaults del esquema y se
  // aplican los valores de process.env que individualmente pasen la validación.
  const flat = parsed.error.flatten().fieldErrors;
  const base = envSchema.parse({}) as Record<string, unknown>;
  for (const key of Object.keys(envSchema.shape)) {
    if (process.env[key] === undefined) continue;
    const probe = { ...base, [key]: process.env[key] };
    if (envSchema.safeParse(probe).success) {
      base[key] = process.env[key];
    }
  }
  env = base as z.infer<typeof envSchema>;
  process.stderr.write(`WARNING: Invalid env vars, usando defaults parciales: ${JSON.stringify(flat)}\n`);
}

export { env };
