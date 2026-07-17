/*
Purpose: assemble the HTTP application without starting a network listener.
Responsibilities: register middleware, versioned routes, error mapping, and dependency-injected handlers.
Connections: server entry point starts it; routes register against the selected framework.
Future: authentication, rate limits, correlation IDs, and health checks.
Best practice: app construction should be deterministic so integration tests can use it in memory.
*/

import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ApplicationError } from "../core/errors.js";
import { InMemoryJobQueue } from "../jobs/job-queue.js";
import { InMemorySourceRepository } from "../database/source-repository.js";
import { SourceService } from "../services/source-service.js";
import { registerSourcesRoutes } from "../routes/sources-routes.js";
import { InMemoryDiscoveryRepository } from "../database/discovery-repository.js";
import { WebsiteCrawler, type WebsiteHttpClient } from "../crawlers/website-crawler.js";
import { StructuralDatasetClassificationService } from "../ai/structural-dataset-classification-service.js";
import type { DatasetClassificationService } from "../ai/dataset-classification-service.js";
import { DiscoveryService } from "../services/discovery-service.js";
import { registerDiscoveryRoutes } from "../routes/discovery-routes.js";
import type { AIProvider } from "../ai/providers/ai-provider.js";
import { createConfiguredGeminiProvider } from "../ai/providers/gemini-provider.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { InMemorySchemaRepository } from "../database/schema-repository.js";
import { SchemaUnderstandingService } from "../services/schema-understanding-service.js";
import { registerSchemaRoutes } from "../routes/schema-routes.js";
import { registerTestingRoutes } from "../routes/testing-routes.js";

export interface ApiApplication extends FastifyInstance {}

export interface BuildAppOptions { readonly websiteHttpClient?: WebsiteHttpClient; readonly datasetClassifier?: DatasetClassificationService; readonly aiProvider?: AIProvider | null; readonly environment?: Environment; }

export async function buildApp(options: BuildAppOptions = {}): Promise<ApiApplication> {
  const app = Fastify({ logger: false });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Universal API",
        version: "1.0.0",
        description: "AI-first source-to-API platform foundation"
      },
      tags: [{ name: "sources", description: "Source registration and lookup" }, { name: "discovery", description: "Dataset discovery and approval" }, { name: "schema", description: "Dataset schema understanding" }]
    }
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_url" || error.code === "invalid_request" ? 400 : 500).send({
        error: error.code,
        message: error.message
      });
    }

    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: "invalid_request", message: "Request validation failed" });
    }

    reply.log.error({ err: error, requestId: request.id }, "Unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  const repository = new InMemorySourceRepository();
  const queue = new InMemoryJobQueue();
  const service = new SourceService(repository, queue);
  const discoveryRepository = new InMemoryDiscoveryRepository();
  const discoveryService = new DiscoveryService(repository, discoveryRepository, new WebsiteCrawler(options.websiteHttpClient), options.datasetClassifier ?? new StructuralDatasetClassificationService());
  const environment = options.environment ?? loadEnvironment();
  const resolvedProvider = options.aiProvider === undefined ? createConfiguredGeminiProvider(environment) : options.aiProvider;
  const providerName = resolvedProvider?.name ?? "deterministic-fallback";
  const providerModel = resolvedProvider?.model ?? environment.aiModel ?? "deterministic-fallback";
  const schemaService = new SchemaUnderstandingService(discoveryRepository, new InMemorySchemaRepository(), resolvedProvider);

  app.log.info({ geminiEnabled: providerName === "gemini", selectedProvider: providerName, selectedModel: providerModel }, "AI provider configuration");

  registerSourcesRoutes(app, service);
  registerDiscoveryRoutes(app, discoveryService);
  registerSchemaRoutes(app, schemaService);
  registerTestingRoutes(app, {
    sourceService: service,
    discoveryService,
    schemaService,
    classifier: options.datasetClassifier ?? new StructuralDatasetClassificationService(),
    providerName,
    providerModel,
    tokenUsage: 0,
    environment
  });

  return app;
}
