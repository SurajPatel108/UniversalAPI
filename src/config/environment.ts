/*
Purpose: define the typed application configuration boundary.
Responsibilities: read, validate, and expose non-secret runtime settings once at startup.
Connections: core/container consumes this object; adapters receive only the configuration they need.
Future: add secret-provider integration and per-environment feature flags.
Best practice: never read process.env throughout the codebase or log credential values.
*/

import { z } from "zod";

export interface Environment {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgresql://localhost:5432/universal_api"),
  REDIS_URL: z.string().default("redis://localhost:6379")
});

export function loadEnvironment(): Environment {
  const parsed = environmentSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL
  };
}

