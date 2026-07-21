/*
Purpose: define the typed application configuration boundary.
Responsibilities: read, validate, and expose non-secret runtime settings once at startup.
Connections: core/container consumes this object; adapters receive only the configuration they need.
Future: add secret-provider integration and per-environment feature flags.
Best practice: never read process.env throughout the codebase or log credential values.
*/

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { z } from "zod";

export interface Environment {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly aiProvider?: string;
  readonly aiModel?: string;
  readonly geminiApiKey?: string;
  readonly crawl4aiBaseUrl?: string;
  readonly crawl4aiToken?: string;
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgresql://localhost:5432/universal_api"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  AI_PROVIDER: z.string().trim().min(1).optional(),
  AI_MODEL: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  CRAWL4AI_BASE_URL: z.string().url().optional(),
  CRAWL4AI_TOKEN: z.string().trim().min(1).optional()
});
let localEnvironmentLoaded = false;

export function loadEnvironment(): Environment {
  loadLocalEnvironment();
  const parsed = environmentSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    aiProvider: parsed.data.AI_PROVIDER,
    aiModel: parsed.data.AI_MODEL,
    geminiApiKey: parsed.data.GEMINI_API_KEY,
    crawl4aiBaseUrl: parsed.data.CRAWL4AI_BASE_URL,
    crawl4aiToken: parsed.data.CRAWL4AI_TOKEN
  };
}

/** Development convenience only: local .env is authoritative over stale shell or IDE variables. */
function loadLocalEnvironment(): void {
  if (localEnvironmentLoaded) return;
  localEnvironmentLoaded = true;
  if (process.env.NODE_ENV === "production") return;
  try {
    const localValues = parseEnv(readFileSync(".env", "utf8"));
    process.loadEnvFile(".env");
    Object.assign(process.env, localValues);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
}
