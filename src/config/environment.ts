/*
Purpose: define the typed application configuration boundary.
Responsibilities: read, validate, and expose non-secret runtime settings once at startup.
Connections: core/container consumes this object; adapters receive only the configuration they need.
Future: add schema validation, secret-provider integration, and per-environment feature flags.
Best practice: never read process.env throughout the codebase or log credential values.
*/

export interface Environment {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

