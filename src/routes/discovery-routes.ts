import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../core/errors.js";
import { defaultDiscoveryLimits } from "../models/discovery.js";
import type { DiscoveryService } from "../services/discovery-service.js";

export const discoveryRoutePrefix = "/v1/discoveries";

const limitsSchema = z.object({ maxPages: z.number().int().positive().max(10_000).optional(), maxDepth: z.number().int().min(0).max(20).optional(), maxBytesPerPage: z.number().int().positive().max(20_000_000).optional(), timeoutMs: z.number().int().positive().max(120_000).optional(), maxRedirects: z.number().int().min(0).max(20).optional(), allowedOrigins: z.array(z.string().url()).max(20).optional() }).optional();
const discoverSchema = z.object({ limits: limitsSchema });
const crawlBudgetSchema = z.object({ maxPages: z.number().int().positive().max(10_000).optional(), maxDepth: z.number().int().min(0).max(20).optional(), maxBytesPerPage: z.number().int().positive().max(20_000_000).optional(), timeoutMs: z.number().int().positive().max(120_000).optional(), maxRedirects: z.number().int().min(0).max(20).optional() }).optional();
const approveSchema = z.object({ candidateIds: z.array(z.string().uuid()).min(1), approvedBy: z.string().min(1).max(200), scope: z.array(z.union([z.string().url(), z.literal("default")])).min(1).optional(), crawlBudget: crawlBudgetSchema });

const discoveryResultParamsSchema = { type: "object", required: ["discoveryResultId"], properties: { discoveryResultId: { type: "string", format: "uuid", description: "The DiscoveryResult identifier returned by POST /v1/sources/{sourceId}/discover." } } };
const approvalBodySchema = {
  type: "object",
  required: ["candidateIds", "approvedBy"],
  properties: {
    candidateIds: { type: "array", minItems: 1, description: "DatasetCandidate IDs selected from the DiscoveryPreview.", items: { type: "string", format: "uuid" } },
    approvedBy: { type: "string", description: "Auditable identifier of the user approving the dataset." },
    scope: { type: "array", description: "Optional subset of selected candidate membership URLs. Use the sentinel \"default\" to select the approved candidate membership URLs.", items: { anyOf: [{ type: "string", format: "uri" }, { type: "string", enum: ["default"] }] } },
    crawlBudget: { type: "object", description: "Optional limits for this crawl. Every override may only reduce the approved discovery limit; maxPages must still cover the selected scope.", properties: { maxPages: { type: "integer", minimum: 1 }, maxDepth: { type: "integer", minimum: 0 }, maxBytesPerPage: { type: "integer", minimum: 1 }, timeoutMs: { type: "integer", minimum: 1 }, maxRedirects: { type: "integer", minimum: 0 } } }
  }
};
const approvalResponseSchema = { type: "object", required: ["dataset", "crawlPlan", "snapshotCollection"], properties: { dataset: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid", description: "Created Dataset ID." } } }, crawlPlan: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid", description: "Created CrawlPlan ID." } } }, snapshotCollection: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid", description: "Created SnapshotCollection ID." } } } } };

export function registerDiscoveryRoutes(app: FastifyInstance, service: DiscoveryService): void {
  app.post("/v1/sources/:sourceId/discover", { schema: { tags: ["discovery"], summary: "Perform bounded deterministic website discovery" } }, async (request: FastifyRequest<{ Params: { sourceId: string } }>, reply: FastifyReply) => {
    const parsed = discoverSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApplicationError("invalid_request", "Invalid discovery request");
    const limits = { ...defaultDiscoveryLimits, ...parsed.data.limits };
    const preview = await service.discover(request.params.sourceId, limits);
    return reply.code(201).send(preview);
  });
  app.get(`${discoveryRoutePrefix}/:discoveryResultId/preview`, { schema: { tags: ["discovery"], summary: "Get a discovery preview", params: discoveryResultParamsSchema } }, async (request: FastifyRequest<{ Params: { discoveryResultId: string } }>) => service.preview(request.params.discoveryResultId));
  app.post(`${discoveryRoutePrefix}/:discoveryResultId/approve`, { schema: { tags: ["discovery"], summary: "Approve candidates, create a crawl plan, and capture snapshots", description: "Approves DatasetCandidates from this DiscoveryResult. The created Dataset, CrawlPlan, and SnapshotCollection are returned by ID.", params: discoveryResultParamsSchema, body: approvalBodySchema, response: { 201: approvalResponseSchema } } }, async (request: FastifyRequest<{ Params: { discoveryResultId: string } }>, reply: FastifyReply) => {
    const parsed = approveSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError("invalid_request", "Invalid dataset approval request");
    const preview = await service.preview(request.params.discoveryResultId);
    if (parsed.data.candidateIds.some((id) => !preview.candidates.some((candidate) => candidate.candidateId === id))) throw new ApplicationError("invalid_request", "Selected candidates do not belong to this discovery result");
    const created = await service.approveAndCapture(parsed.data);
    return reply.code(201).send({ dataset: { id: created.dataset.id }, crawlPlan: { id: created.crawlPlan.id }, snapshotCollection: { id: created.snapshots.id } });
  });
}

export function registerSourceDiscoveryPreviewRoute(app: FastifyInstance, service: DiscoveryService): void {
  app.get("/v1/sources/:sourceId/discovery-preview", { schema: { tags: ["discovery"], summary: "Get the newest completed discovery preview for a source" } }, async (request: FastifyRequest<{ Params: { sourceId: string } }>) => {
    const preview = await service.latestPreviewForSource(request.params.sourceId);
    if (!preview) throw new ApplicationError("not_found", "No completed discovery preview exists for this source");
    return preview;
  });
}
