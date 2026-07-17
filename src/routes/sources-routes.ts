/*
Purpose: own HTTP endpoints for source creation, retrieval, and manual refresh.
Responsibilities: parse request DTOs, call SourceService, and map results/errors to versioned HTTP responses.
Connections: registered by api/app; delegates all business behavior to services.
Future: POST /v1/sources, GET /v1/sources/:id, POST /v1/sources/:id/refresh and OpenAPI schemas.
Best practice: validate untrusted input at this boundary and never let framework types leak into services.
*/

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../core/errors.js";
import type { SourceService } from "../services/source-service.js";

export const sourcesRoutePrefix = "/v1/sources";

const createSourceSchema = z.object({
  sourceType: z.enum(["website", "pdf", "spreadsheet", "database", "notion", "custom"]),
  url: z.string().url()
});

export function registerSourcesRoutes(app: FastifyInstance, service: SourceService): void {
  app.post(
    sourcesRoutePrefix,
    {
      schema: {
        tags: ["sources"],
        summary: "Create a source",
        body: {
          type: "object",
          required: ["sourceType", "url"],
          properties: {
            sourceType: { type: "string" },
            url: { type: "string", format: "uri" }
          }
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              publicSlug: { type: "string" },
              sourceType: { type: "string" },
              url: { type: "string" },
              status: { type: "string" }
            }
          }
        }
      }
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSourceSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApplicationError("invalid_request", "Invalid request payload", false);
      }

      const source = await service.createSource(parsed.data);
      return reply.code(201).send(source);
    }
  );

  app.get(
    `${sourcesRoutePrefix}/:id`,
    {
      schema: {
        tags: ["sources"],
        summary: "Get a source by id",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" }
          }
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              publicSlug: { type: "string" },
              sourceType: { type: "string" },
              url: { type: "string" },
              status: { type: "string" }
            }
          }
        }
      }
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const source = await service.getSource(request.params.id);
      if (!source) {
        throw new ApplicationError("not_found", "Source not found", false);
      }

      return reply.send(source);
    }
  );
}

