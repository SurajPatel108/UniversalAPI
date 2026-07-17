/*
Purpose: own HTTP endpoints for source creation, retrieval, and manual refresh.
Responsibilities: parse request DTOs, call SourceService, and map results/errors to versioned HTTP responses.
Connections: registered by api/app; delegates all business behavior to services.
Future: POST /v1/sources, GET /v1/sources/:id, POST /v1/sources/:id/refresh and OpenAPI schemas.
Best practice: validate untrusted input at this boundary and never let framework types leak into services.
*/

export const sourcesRoutePrefix = "/v1/sources";

