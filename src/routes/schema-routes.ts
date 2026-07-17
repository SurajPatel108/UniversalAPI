import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SchemaUnderstandingService } from "../services/schema-understanding-service.js";

export function registerSchemaRoutes(app: FastifyInstance, service: SchemaUnderstandingService): void {
  app.post(
    "/v1/snapshot-collections/:snapshotCollectionId/schema",
    {
      schema: {
        tags: ["schema"],
        summary: "Analyze representative redacted collection samples into a schema",
        params: {
          type: "object",
          required: ["snapshotCollectionId"],
          properties: { snapshotCollectionId: { type: "string", format: "uuid" } }
        },
        response: {
          201: {
            type: "object",
            required: ["id", "datasetId", "snapshotCollectionId", "schema", "fields", "rationale", "sampleSnapshotIds", "provenance", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              datasetId: { type: "string", format: "uuid" },
              snapshotCollectionId: { type: "string", format: "uuid" },
              collectionRevision: { type: "string" },
              schema: {
                type: "object",
                required: ["type", "properties", "required"],
                properties: {
                  type: { type: "string" },
                  properties: { type: "object" },
                  required: { type: "array", items: { type: "string" } }
                }
              },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "type", "required", "confidence", "evidence"],
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    required: { type: "boolean" },
                    confidence: { type: "number" },
                    evidence: { type: "string" }
                  }
                }
              },
              rationale: { type: "string" },
              sampleSnapshotIds: { type: "array", items: { type: "string" } },
              provenance: {
                type: "object",
                required: ["model", "promptVersion", "confidence"],
                properties: {
                  model: { type: "string" },
                  promptVersion: { type: "string" },
                  confidence: { type: "number" }
                }
              },
              createdAt: { type: "string", format: "date-time" }
            }
          }
        }
      }
    },
    async (request: FastifyRequest<{ Params: { snapshotCollectionId: string } }>, reply) => reply.code(201).send(await service.analyze(request.params.snapshotCollectionId))
  );
}
