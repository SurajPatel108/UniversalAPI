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

export interface ApiApplication extends FastifyInstance {}

export async function buildApp(): Promise<ApiApplication> {
  const app = Fastify({ logger: false });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Universal API",
        version: "1.0.0",
        description: "AI-first source-to-API platform foundation"
      },
      tags: [{ name: "sources", description: "Source registration and lookup" }]
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

  registerSourcesRoutes(app, service);

  return app;
}

