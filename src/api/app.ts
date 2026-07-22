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
import { createWebsiteConnector } from "../connectors/website-connector.js";
import type { DatasetDiscoveryConnector } from "../connectors/connector.js";
import { StructuralDatasetClassificationService } from "../ai/structural-dataset-classification-service.js";
import type { DatasetClassificationService } from "../ai/dataset-classification-service.js";
import { DiscoveryService } from "../services/discovery-service.js";
import { registerDiscoveryRoutes, registerSourceDiscoveryPreviewRoute } from "../routes/discovery-routes.js";
import { RefreshSourceWorker } from "../workers/refresh-source-worker.js";
import type { AIProvider } from "../ai/providers/ai-provider.js";
import { createConfiguredGeminiProvider } from "../ai/providers/gemini-provider.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { InMemorySchemaRepository } from "../database/schema-repository.js";
import { SchemaUnderstandingService } from "../services/schema-understanding-service.js";
import { registerSchemaRoutes } from "../routes/schema-routes.js";
import { registerTestingRoutes } from "../routes/testing-routes.js";
import { InMemoryExtractionRepository } from "../database/extraction-repository.js";
import { SchemaApprovalService } from "../services/schema-approval-service.js";
import { ExtractionPlanGenerationService } from "../services/extraction-plan-generation-service.js";
import { ExtractionExecutionService } from "../services/extraction-execution-service.js";
import { DevelopmentPhase4WorkflowService } from "../services/development-phase4-workflow-service.js";

export interface ApiApplication extends FastifyInstance {}

export interface BuildAppOptions { readonly websiteConnector?: DatasetDiscoveryConnector; readonly datasetClassifier?: DatasetClassificationService; readonly aiProvider?: AIProvider | null; readonly environment?: Environment; }

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
  const environment = options.environment ?? loadEnvironment();
  const websiteConnector = options.websiteConnector ?? createWebsiteConnector(environment.crawl4aiBaseUrl, environment.crawl4aiToken);
  const discoveryService = new DiscoveryService(repository, discoveryRepository, websiteConnector, options.datasetClassifier ?? new StructuralDatasetClassificationService());
  const refreshWorker = new RefreshSourceWorker(discoveryService);
  queue.subscribeRefresh((job) => refreshWorker.process(job).then(() => undefined));
  const resolvedProvider = options.aiProvider === undefined ? createConfiguredGeminiProvider(environment) : options.aiProvider;
  const providerName = resolvedProvider?.name ?? "deterministic-fallback";
  const providerModel = resolvedProvider?.model ?? environment.aiModel ?? "deterministic-fallback";
  const schemaRepository = new InMemorySchemaRepository();
  const extractionRepository = new InMemoryExtractionRepository();
  const schemaService = new SchemaUnderstandingService(discoveryRepository, schemaRepository, resolvedProvider);
  const phase4Workflow = new DevelopmentPhase4WorkflowService(
    new SchemaApprovalService(schemaRepository),
    new ExtractionPlanGenerationService(discoveryRepository, schemaRepository, extractionRepository, resolvedProvider),
    new ExtractionExecutionService(discoveryRepository, schemaRepository, extractionRepository)
  );

  app.log.info({ geminiEnabled: providerName === "gemini", selectedProvider: providerName, selectedModel: providerModel }, "AI provider configuration");

  registerSourcesRoutes(app, service);
  registerDiscoveryRoutes(app, discoveryService);
  registerSourceDiscoveryPreviewRoute(app, discoveryService);
  registerSchemaRoutes(app, schemaService);
  registerTestingRoutes(app, {
    sourceService: service,
    discoveryService,
    schemaService,
    phase4Workflow,
    classifier: options.datasetClassifier ?? new StructuralDatasetClassificationService(),
    providerName,
    providerModel,
    tokenUsage: 0,
    environment
  });

  return app;
}
