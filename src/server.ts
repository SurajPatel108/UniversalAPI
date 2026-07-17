/*
Purpose: process entry point for the HTTP deployment.
Responsibilities: load validated configuration, build the dependency container, and start/stop the API server.
Connections: composes core/container with api/app; workers use a separate entry point so web scaling is independent.
Future: graceful shutdown, telemetry bootstrap, and process-level error handling.
Best practice: keep business logic out of this file and make startup explicit and testable.
*/

import pino from "pino";
import { buildApp } from "./api/app.js";
import { loadEnvironment } from "./config/environment.js";
import { createConfiguredGeminiProvider } from "./ai/providers/gemini-provider.js";

async function main(): Promise<void> {
  const env = loadEnvironment();
  const logger = pino({ level: env.nodeEnv === "production" ? "info" : "debug" });
  const provider = createConfiguredGeminiProvider(env);
  logger.info({ geminiEnabled: Boolean(provider), selectedProvider: provider?.name ?? "deterministic-fallback", selectedModel: provider?.model ?? env.aiModel ?? "deterministic-fallback" }, "AI provider configuration");
  const app = await buildApp();

  await app.listen({ port: env.port, host: "0.0.0.0" });
  logger.info({ port: env.port }, "Universal API server listening");
}

main().catch((error: unknown) => {
  const logger = pino();
  logger.error({ err: error }, "Failed to start Universal API server");
  process.exitCode = 1;
});

